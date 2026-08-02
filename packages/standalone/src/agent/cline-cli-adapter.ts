import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import type {
  CompletedToolExchange,
  PromptCallbacks,
  PromptResult,
  ToolUseBlock,
} from './types.js';
import {
  HostToolAbortError,
  HostToolTerminalError,
  ModelRunnerError,
  type HostToolBridge,
  type HostToolCallResult,
  type HostToolDefinition,
  type IModelRunner,
  type ModelRunnerErrorCode,
  type PromptOptions,
  type RunnerMetrics,
  type SessionPolicyStatus,
} from './model-runner.js';
import { isClineMcpToolGrant } from './cline-native-tool-policy.js';
import {
  completedCodeActMutationWasObserved,
  completedCodeActTerminalError,
} from './code-act/completed-terminal-result.js';
import { McpCompletedMutationInterruptedError, McpResultMissingError } from './types.js';

const CLINE_CODE_ACT_TOOL_NAME = 'mcp__code-act__code_act';
const MAMA_CODE_ACT_TOOL_NAME = 'code_act';
const CLINE_MUTATION_SETTLEMENT_GRACE_MS = 5_250;

export interface ClineHubToolContext {
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}

export interface ClineHubToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  timeoutMs?: number;
  retryable?: boolean;
  maxRetries?: number;
  execute(input: Record<string, unknown>, context: ClineHubToolContext): Promise<unknown>;
}

export interface ClineHubClient {
  readonly runtimeAddress?: string;
  start(input: unknown): Promise<{ sessionId: string }>;
  send(input: { sessionId: string; prompt: string; timeoutMs?: number }): Promise<unknown>;
  subscribe(listener: (event: unknown) => void, options?: unknown): () => void;
  get(sessionId: string): Promise<unknown | undefined>;
  abort(sessionId: string, reason?: unknown): Promise<void>;
  stop(sessionId: string): Promise<void>;
  dispose(reason?: string): Promise<void>;
}

export interface ClineHubRuntime {
  client: ClineHubClient;
  source: unknown;
  apiKey?: string;
  createTool(definition: ClineHubToolDefinition): unknown;
}

interface ClineHubRuntimeFactoryInput {
  command: string;
  cwd: string;
  dataDir?: string;
  provider: string;
}

export type ClineHubRuntimeFactory = (
  input: ClineHubRuntimeFactoryInput
) => Promise<ClineHubRuntime>;

export interface ClineCLIAdapterOptions {
  command?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  mcpConfigPath?: string;
  dataDir?: string;
  requestTimeout?: number;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowSpawnAgent?: boolean;
  allowAgentTeams?: boolean;
  maxSessions?: number;
  sessionTtlMs?: number;
  runtimeFactory?: ClineHubRuntimeFactory;
}

interface ImportedClineSdk {
  ClineCore: {
    create(options: unknown): Promise<ClineHubClient>;
  };
  ProviderSettingsManager: new (options?: { dataDir?: string }) => {
    getProviderSettings(provider: string): unknown;
  };
  getPersistedProviderApiKey(provider: string, settings: unknown): string | undefined;
  createTool(definition: ClineHubToolDefinition): unknown;
  SessionSource?: Record<string, unknown>;
}

interface ActiveAttempt {
  bridge?: HostToolBridge;
  controller: AbortController;
  signal: AbortSignal;
  terminalResult?: HostToolCallResult;
  completed: Map<string, CompletedToolExchange>;
  pendingTools: Map<string, ToolUseBlock>;
  claimedToolCallIds: Set<string>;
  executedToolCallIds: Set<string>;
  inFlightTools: Set<Promise<void>>;
}

interface ClineSessionRecord {
  routeId: string;
  hubSessionId: string;
  model: string;
  policyFingerprint?: string;
  toolFingerprint: string;
  lastActiveAt: number;
  activeAttempt?: ActiveAttempt;
}

interface ClineAgentResult {
  text: string;
  finishReason: string;
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalCost?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function normalizeToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}

function classifyFailure(message: string): ModelRunnerErrorCode {
  const normalized = message.toLowerCase();
  if (/quota|rate.?limit|\b429\b/.test(normalized)) {
    return 'rate_limit';
  }
  if (/unauthorized|authentication|invalid api key|credentials?|\b401\b|\b403\b/.test(normalized)) {
    return 'auth_failure';
  }
  if (/context.{0,20}(length|window|overflow)|too many tokens/.test(normalized)) {
    return 'context_overflow';
  }
  if (/timed? out|timeout/.test(normalized)) {
    return 'timeout';
  }
  return 'crash';
}

export function resolveClineDataDir(dataDir: string): string {
  if (dataDir === '~') {
    return homedir();
  }
  if (dataDir.startsWith('~/')) {
    return resolve(homedir(), dataDir.slice(2));
  }
  return resolve(dataDir);
}

function safeProviderFailure(
  rawText: string,
  finishReason: string
): {
  code: ModelRunnerErrorCode;
  message: string;
} {
  const code = classifyFailure(rawText || finishReason);
  let providerCode: string | undefined;
  let providerMessage = '';
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      providerCode = stringValue(parsed.error, 'code')
        ?.replace(/[^A-Za-z0-9_.-]/g, '')
        .slice(0, 64);
      providerMessage = stringValue(parsed.error, 'message') ?? '';
    }
  } catch {
    providerMessage = rawText;
  }

  const reason = finishReason.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32) || 'unknown';
  const suffix = providerCode ? `, provider=${providerCode}` : '';
  if (code === 'rate_limit') {
    const retryHint = providerMessage.match(
      /try again in\s+\d+\s*(?:days?|hours?|minutes?|seconds?|[dhms])(?:\s+\d+\s*(?:days?|hours?|minutes?|seconds?|[dhms])){0,3}/i
    )?.[0];
    return {
      code,
      message:
        `Cline Hub run failed (rate_limit${suffix}): Daily free limit reached${retryHint ? `. ${retryHint}` : ''}`.slice(
          0,
          320
        ),
    };
  }
  if (code === 'auth_failure') {
    return {
      code,
      message: `Cline Hub authentication failed${suffix}. Run: cline auth cline`.slice(0, 320),
    };
  }
  const label =
    code === 'context_overflow'
      ? 'context limit exceeded'
      : code === 'timeout'
        ? 'request timed out'
        : `run ended with finish reason ${reason}`;
  return { code, message: `Cline Hub ${label}${suffix}`.slice(0, 320) };
}

function executableCandidates(command: string): string[] {
  if (isAbsolute(command) || command.includes('/')) {
    return [resolve(command)];
  }
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  return pathEntries.flatMap((entry) =>
    suffixes.map((suffix) => join(entry, `${command}${suffix}`))
  );
}

function resolveClineWrapper(command: string): string {
  for (const candidate of executableCandidates(command)) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through PATH candidates.
    }
  }
  throw new Error(`Cline CLI executable not found: ${command}`);
}

function resolveClineSdkEntry(wrapperPath: string): string {
  let current = dirname(wrapperPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'node_modules', '@cline', 'core', 'dist', 'index.js');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    `The installed Cline CLI does not include its companion @cline/core runtime: ${wrapperPath}`
  );
}

function validateImportedSdk(value: unknown): ImportedClineSdk {
  if (!isRecord(value)) {
    throw new Error('Cline companion SDK did not export an object');
  }
  const clineCore = value.ClineCore;
  const providerManager = value.ProviderSettingsManager;
  const clineCoreCreate =
    (typeof clineCore === 'function' || isRecord(clineCore)) &&
    typeof (clineCore as { create?: unknown }).create === 'function';
  if (
    !clineCoreCreate ||
    typeof providerManager !== 'function' ||
    typeof value.getPersistedProviderApiKey !== 'function' ||
    typeof value.createTool !== 'function'
  ) {
    throw new Error('Cline companion SDK is missing the Hub session API required by MAMA');
  }
  return value as unknown as ImportedClineSdk;
}

export async function hasPersistedClineCredential(
  options: {
    command?: string;
    provider?: string;
    dataDir?: string;
  } = {}
): Promise<boolean> {
  const wrapperPath = resolveClineWrapper(
    options.command ?? process.env.MAMA_CLINE_COMMAND ?? process.env.CLINE_COMMAND ?? 'cline'
  );
  const sdkEntry = resolveClineSdkEntry(wrapperPath);
  const imported: unknown = await import(pathToFileURL(sdkEntry).href);
  const sdk = validateImportedSdk(imported);
  const dataDir = options.dataDir ? resolveClineDataDir(options.dataDir) : undefined;
  const manager = new sdk.ProviderSettingsManager(dataDir ? { dataDir } : undefined);
  const provider = options.provider ?? 'cline';
  return Boolean(sdk.getPersistedProviderApiKey(provider, manager.getProviderSettings(provider)));
}

const defaultRuntimeFactory: ClineHubRuntimeFactory = async (input) => {
  const wrapperPath = resolveClineWrapper(input.command);
  const sdkEntry = resolveClineSdkEntry(wrapperPath);

  if (input.dataDir) {
    const requestedDataDir = resolveClineDataDir(input.dataDir);
    const existingDataDir = process.env.CLINE_DATA_DIR?.trim();
    if (existingDataDir && resolveClineDataDir(existingDataDir) !== requestedDataDir) {
      throw new Error(
        `Cline Hub data directory is already bound to ${existingDataDir}; cannot switch to ${input.dataDir}`
      );
    }
    process.env.CLINE_DATA_DIR = requestedDataDir;
  }
  process.env.CLINE_WRAPPER_PATH = wrapperPath;

  const imported: unknown = await import(pathToFileURL(sdkEntry).href);
  const sdk = validateImportedSdk(imported);
  const providerManager = new sdk.ProviderSettingsManager(
    input.dataDir ? { dataDir: resolveClineDataDir(input.dataDir) } : undefined
  );
  const providerSettings = providerManager.getProviderSettings(input.provider);
  const apiKey = sdk.getPersistedProviderApiKey(input.provider, providerSettings);
  const client = await sdk.ClineCore.create({
    clientName: 'mama-os',
    backendMode: 'hub',
    hub: {
      cwd: input.cwd,
      workspaceRoot: input.cwd,
      clientType: 'mama-os',
      displayName: 'MAMA OS',
      strategy: 'require-hub',
    },
  });
  return {
    client,
    source: sdk.SessionSource?.CORE ?? 'core',
    apiKey,
    createTool: (definition) => sdk.createTool(definition),
  };
};

function parseAgentResult(value: unknown): ClineAgentResult {
  if (!isRecord(value)) {
    throw new Error('Cline Hub returned no agent result');
  }
  const usage = isRecord(value.usage) ? value.usage : undefined;
  return {
    text: stringValue(value, 'text') ?? '',
    finishReason: stringValue(value, 'finishReason') ?? 'unknown',
    durationMs: numberValue(value, 'durationMs'),
    usage: usage
      ? {
          inputTokens: numberValue(usage, 'inputTokens'),
          outputTokens: numberValue(usage, 'outputTokens'),
          cacheReadTokens: numberValue(usage, 'cacheReadTokens'),
          cacheWriteTokens: numberValue(usage, 'cacheWriteTokens'),
          totalCost: numberValue(usage, 'totalCost'),
        }
      : undefined,
  };
}

function toolFingerprint(
  bridge: HostToolBridge | undefined,
  allowedTools: readonly string[],
  disallowedTools: readonly string[],
  allowSpawnAgent: boolean,
  allowAgentTeams: boolean
): string {
  return JSON.stringify({
    projectedTools: (bridge?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    allowedTools,
    disallowedTools,
    allowSpawnAgent,
    allowAgentTeams,
  });
}

function buildToolPolicies(
  bridge: HostToolBridge | undefined,
  allowedTools: readonly string[],
  disallowedTools: readonly string[]
): Record<string, { enabled: boolean; autoApprove: boolean }> {
  const allowAll = allowedTools.includes('*');
  const policies: Record<string, { enabled: boolean; autoApprove: boolean }> = {
    '*': { enabled: allowAll, autoApprove: allowAll },
  };
  if (!allowAll) {
    for (const tool of allowedTools) {
      policies[tool] = { enabled: true, autoApprove: true };
    }
  }
  for (const tool of disallowedTools) {
    policies[tool] = { enabled: false, autoApprove: false };
  }
  for (const definition of bridge?.tools ?? []) {
    const name =
      definition.name === MAMA_CODE_ACT_TOOL_NAME ? CLINE_CODE_ACT_TOOL_NAME : definition.name;
    policies[name] = { enabled: true, autoApprove: true };
  }
  return policies;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) {
    return new AbortController().signal;
  }
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ModelRunnerError('Cline Hub request was aborted', 'unknown', false);
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      }
    );
  });
}

export class ClineCLIAdapter extends EventEmitter implements IModelRunner {
  readonly backendType = 'cline' as const;

  private readonly options: ClineCLIAdapterOptions;
  private readonly runtimeFactory: ClineHubRuntimeFactory;
  private readonly sessions = new Map<string, ClineSessionRecord>();
  private readonly stableRoutes = new Map<string, string>();
  private readonly routesRequiringRebuild = new Set<string>();
  private readonly routeTails = new Map<string, Promise<void>>();
  private readonly activeRoutes = new Set<string>();
  private sessionLifecycleTail: Promise<void> = Promise.resolve();
  private runtimePromise: Promise<ClineHubRuntime> | null = null;
  private readonly disposedRuntimes = new WeakSet<ClineHubRuntime>();
  private runtimeWaiters = 0;
  private sessionId: string;
  private systemPrompt: string;
  private requestCount = 0;
  private failureCount = 0;
  private totalLatencyMs = 0;
  private lastRequestAt: number | null = null;
  private stopped = false;
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;

  constructor(options: ClineCLIAdapterOptions = {}) {
    super();
    this.options = {
      ...options,
      command: options.command ?? process.env.MAMA_CLINE_COMMAND ?? process.env.CLINE_COMMAND,
    };
    this.runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;
    this.sessionId = options.sessionId ?? 'cline';
    this.systemPrompt = options.systemPrompt ?? '';
    this.maxSessions = Math.max(1, options.maxSessions ?? 100);
    this.sessionTtlMs = Math.max(1, options.sessionTtlMs ?? 1_800_000);
  }

  async prompt(
    content: string,
    callbacks?: PromptCallbacks,
    promptOptions?: PromptOptions
  ): Promise<PromptResult> {
    const startedAt = Date.now();
    const routeId = promptOptions?.sessionId ?? promptOptions?.sessionKey ?? this.sessionId;
    const stableRouteId = promptOptions?.sessionKey ?? routeId;
    const timeoutMs = promptOptions?.requestTimeout ?? this.options.requestTimeout ?? 600_000;
    const deadlineController = new AbortController();
    let lockAcquired = false;
    const timeoutHandle = setTimeout(() => {
      const error = new ModelRunnerError(
        `Cline Hub request timed out after ${timeoutMs}ms`,
        'timeout',
        true
      );
      deadlineController.abort(error);
      if (lockAcquired) {
        void this.abortRoute(routeId, error);
      }
    }, timeoutMs);
    timeoutHandle.unref();
    this.requestCount += 1;
    this.lastRequestAt = startedAt;

    try {
      return await this.withRouteLock(
        stableRouteId,
        deadlineController.signal,
        () => {
          lockAcquired = true;
          this.activeRoutes.add(routeId);
        },
        async () => {
          try {
            return await this.runHubPrompt(
              routeId,
              stableRouteId,
              content,
              callbacks,
              promptOptions,
              deadlineController.signal,
              timeoutMs
            );
          } finally {
            this.activeRoutes.delete(routeId);
          }
        }
      );
    } catch (error) {
      this.failureCount += 1;
      const normalized = this.normalizeError(error);
      if (lockAcquired && normalized instanceof ModelRunnerError && normalized.code === 'timeout') {
        await this.quarantineRoute(routeId);
      }
      callbacks?.onError?.(normalized);
      throw normalized;
    } finally {
      clearTimeout(timeoutHandle);
      this.totalLatencyMs += Date.now() - startedAt;
      if (this.routeTails.size === 0) {
        this.emit('idle');
      }
    }
  }

  private async withRouteLock<T>(
    routeId: string,
    signal: AbortSignal,
    onAcquired: () => void,
    run: () => Promise<T>
  ): Promise<T> {
    const previous = this.routeTails.get(routeId) ?? Promise.resolve();
    let acquired = false;
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new ModelRunnerError('Cline Hub request was aborted', 'unknown');
        }
        acquired = true;
        onAcquired();
        return await run();
      });
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.routeTails.set(routeId, tail);
    void tail.then(() => {
      if (this.routeTails.get(routeId) === tail) {
        this.routeTails.delete(routeId);
      }
    });
    return await new Promise<T>((resolvePromise, rejectPromise) => {
      const onAbort = (): void => {
        if (!acquired) {
          rejectPromise(abortError(signal));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      current.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolvePromise(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          rejectPromise(error);
        }
      );
    });
  }

  private async withSessionLifecycleLock<T>(
    signal: AbortSignal,
    run: () => Promise<T>
  ): Promise<T> {
    const current = this.sessionLifecycleTail
      .catch(() => undefined)
      .then(async () => {
        if (signal.aborted) {
          throw abortError(signal);
        }
        return await run();
      });
    this.sessionLifecycleTail = current.then(
      () => undefined,
      () => undefined
    );
    return await raceWithAbort(current, signal);
  }

  private async getRuntime(signal: AbortSignal): Promise<ClineHubRuntime> {
    if (this.stopped) {
      throw new ModelRunnerError('Cline Hub adapter is stopped', 'crash', false);
    }
    if (!this.runtimePromise) {
      const pending = this.runtimeFactory({
        command: this.options.command ?? 'cline',
        cwd: this.options.cwd ?? process.cwd(),
        dataDir: this.options.dataDir,
        provider: this.options.provider ?? 'cline',
      });
      this.runtimePromise = pending;
      void pending.catch(() => {
        if (this.runtimePromise === pending) {
          this.runtimePromise = null;
        }
      });
    }
    const pending = this.runtimePromise;
    this.runtimeWaiters += 1;
    try {
      const runtime = await raceWithAbort(pending, signal);
      if (this.stopped) {
        void this.disposeRuntimeOnce(runtime, 'mama_shutdown').catch(() => undefined);
        throw new ModelRunnerError('Cline Hub adapter is stopped', 'crash', false);
      }
      return runtime;
    } catch (error) {
      if (signal.aborted && this.runtimePromise === pending && this.runtimeWaiters === 1) {
        this.runtimePromise = null;
        void pending
          .then((runtime) => this.disposeRuntimeOnce(runtime, 'mama_request_deadline'))
          .catch(() => undefined);
      }
      throw error;
    } finally {
      this.runtimeWaiters -= 1;
    }
  }

  private async abortRoute(routeId: string, reason: Error): Promise<void> {
    const pendingRuntime = this.runtimePromise;
    const session = this.sessions.get(routeId);
    if (!pendingRuntime || !session) {
      return;
    }
    const runtime = await pendingRuntime.catch(() => null);
    await runtime?.client.abort(session.hubSessionId, reason).catch(() => undefined);
  }

  private async quarantineRoute(routeId: string): Promise<void> {
    const session = this.sessions.get(routeId);
    if (!session) {
      return;
    }
    if (this.sessions.get(routeId) === session) {
      this.sessions.delete(routeId);
      this.removeStableRoute(routeId);
      this.markRouteForRebuild(routeId);
    }
    const pendingRuntime = this.runtimePromise;
    if (pendingRuntime) {
      void pendingRuntime
        .then((runtime) => runtime.client.stop(session.hubSessionId))
        .catch(() => undefined);
    }
  }

  private async disposeRuntimeOnce(runtime: ClineHubRuntime, reason: string): Promise<void> {
    if (this.disposedRuntimes.has(runtime)) {
      return;
    }
    this.disposedRuntimes.add(runtime);
    await runtime.client.dispose(reason);
  }

  private async runHubPrompt(
    routeId: string,
    stableRouteId: string,
    content: string,
    callbacks: PromptCallbacks | undefined,
    promptOptions: PromptOptions | undefined,
    deadlineSignal: AbortSignal,
    timeoutMs: number
  ): Promise<PromptResult> {
    const runtime = await this.getRuntime(deadlineSignal);
    const model = promptOptions?.model ?? this.options.model;
    if (!model) {
      throw new ModelRunnerError('Cline model is required', 'auth_failure', false);
    }
    if (!runtime.apiKey && (this.options.provider ?? 'cline') === 'cline') {
      const unauthenticatedRuntime = this.runtimePromise;
      this.runtimePromise = null;
      if (unauthenticatedRuntime) {
        void this.disposeRuntimeOnce(runtime, 'mama_auth_reload').catch(() => undefined);
      }
      throw new ModelRunnerError(
        'Cline credentials are unavailable. Run: cline auth cline',
        'auth_failure',
        false
      );
    }

    const previousRouteId = this.stableRoutes.get(stableRouteId);
    if (previousRouteId && previousRouteId !== routeId) {
      const previousSession = this.sessions.get(previousRouteId);
      if (previousSession) {
        await raceWithAbort(
          runtime.client.stop(previousSession.hubSessionId).catch(() => undefined),
          deadlineSignal
        );
        this.sessions.delete(previousRouteId);
      }
    }
    const requestedPolicy = promptOptions?.sessionPolicyFingerprint;
    const allowedTools = promptOptions?.allowedTools ?? this.options.allowedTools ?? [];
    const disallowedTools = promptOptions?.disallowedTools ?? this.options.disallowedTools ?? [];
    const allowSpawnAgent = promptOptions?.allowSpawnAgent ?? this.options.allowSpawnAgent ?? false;
    const allowAgentTeams = promptOptions?.allowAgentTeams ?? this.options.allowAgentTeams ?? false;
    const requestedToolFingerprint = toolFingerprint(
      promptOptions?.hostToolBridge,
      allowedTools,
      disallowedTools,
      allowSpawnAgent,
      allowAgentTeams
    );
    let session = this.sessions.get(routeId);
    const mappedSessionWasMissing =
      session !== undefined &&
      !(await raceWithAbort(runtime.client.get(session.hubSessionId), deadlineSignal));
    if (mappedSessionWasMissing) {
      this.sessions.delete(routeId);
      this.removeStableRoute(routeId);
      session = undefined;
    }

    const incompatibleSession =
      session &&
      (promptOptions?.resumeSession === false ||
        session.model !== model ||
        session.policyFingerprint !== requestedPolicy ||
        session.toolFingerprint !== requestedToolFingerprint)
        ? session
        : undefined;
    let systemPrompt = promptOptions?.systemPrompt ?? this.systemPrompt;
    if (mappedSessionWasMissing && promptOptions?.resumeInstructions) {
      systemPrompt = await raceWithAbort(promptOptions.resumeInstructions(), deadlineSignal);
    }
    if (incompatibleSession) {
      await raceWithAbort(
        runtime.client.stop(incompatibleSession.hubSessionId).catch(() => undefined),
        deadlineSignal
      );
      this.sessions.delete(routeId);
      this.removeStableRoute(routeId);
      session = undefined;
      if (promptOptions?.resumeInstructions) {
        systemPrompt = await raceWithAbort(promptOptions.resumeInstructions(), deadlineSignal);
      }
    }

    if (
      !session &&
      promptOptions?.resumeSession !== false &&
      this.routesRequiringRebuild.has(routeId) &&
      promptOptions?.resumeInstructions
    ) {
      systemPrompt = await raceWithAbort(promptOptions.resumeInstructions(), deadlineSignal);
    }

    if (!session) {
      session = await this.withSessionLifecycleLock(deadlineSignal, async () => {
        const existingSession = this.sessions.get(routeId);
        if (existingSession) {
          return existingSession;
        }
        await this.retireStaleSessions(runtime, routeId, deadlineSignal);
        if (this.sessions.size >= this.maxSessions) {
          throw new ModelRunnerError(
            'Cline Hub session capacity is fully active; retry after an active request completes',
            'crash',
            true
          );
        }
        const createdSession = await this.startHubSession(
          runtime,
          routeId,
          model,
          systemPrompt,
          requestedPolicy,
          promptOptions?.hostToolBridge,
          requestedToolFingerprint,
          promptOptions?.requestTimeout,
          allowedTools,
          disallowedTools,
          allowSpawnAgent,
          allowAgentTeams,
          deadlineSignal
        );
        this.sessions.set(routeId, createdSession);
        return createdSession;
      });
    }
    this.stableRoutes.set(stableRouteId, routeId);
    this.routesRequiringRebuild.delete(routeId);
    session.lastActiveAt = Date.now();

    const attemptController = new AbortController();
    const ownerSignal = promptOptions?.toolExecutionContext?.signal;
    const pendingTools = new Map<string, ToolUseBlock>();
    const attempt: ActiveAttempt = {
      bridge: promptOptions?.hostToolBridge,
      controller: attemptController,
      signal: combineSignals(ownerSignal, attemptController.signal, deadlineSignal),
      completed: new Map<string, CompletedToolExchange>(),
      pendingTools,
      claimedToolCallIds: new Set<string>(),
      executedToolCallIds: new Set<string>(),
      inFlightTools: new Set<Promise<void>>(),
    };
    session.activeAttempt = attempt;
    const unsubscribe = runtime.client.subscribe(
      (event) => this.processHubEvent(event, session!, attempt, pendingTools, callbacks),
      { sessionId: session.hubSessionId }
    );

    const abortOwner = (): void => {
      const error = new ModelRunnerError('Cline Hub request was aborted by its owner', 'unknown');
      attemptController.abort(error);
      void runtime.client.abort(session!.hubSessionId, error).catch(() => undefined);
    };
    ownerSignal?.addEventListener('abort', abortOwner, { once: true });

    try {
      if (ownerSignal?.aborted) {
        abortOwner();
        throw new ModelRunnerError('Cline Hub request was aborted by its owner', 'unknown');
      }
      const rawResult = await raceWithAbort(
        runtime.client.send({ sessionId: session.hubSessionId, prompt: content, timeoutMs }),
        deadlineSignal
      );
      const result = parseAgentResult(rawResult);
      const completedToolExchanges = [...attempt.completed.values()];
      const completedTerminal =
        attempt.terminalResult?.terminalCode && attempt.terminalResult.abort
          ? {
              code: attempt.terminalResult.terminalCode,
              message: attempt.terminalResult.content,
            }
          : completedCodeActTerminalError(completedToolExchanges);
      if (!completedTerminal && (attempt.terminalResult?.abort || attempt.terminalResult?.stop)) {
        throw new HostToolAbortError(
          'MAMA host tool aborted the active Cline run',
          completedToolExchanges
        );
      }
      if (result.finishReason !== 'completed') {
        const failure = safeProviderFailure(result.text.trim(), result.finishReason);
        throw new ModelRunnerError(failure.message, failure.code, failure.code !== 'auth_failure');
      }
      const unresolvedCodeActIds = [...pendingTools.values()]
        .filter((toolUse) => toolUse.name === CLINE_CODE_ACT_TOOL_NAME)
        .map((toolUse) => toolUse.id);
      if (unresolvedCodeActIds.length > 0) {
        throw new McpResultMissingError(unresolvedCodeActIds);
      }

      const promptResult: PromptResult = {
        response: result.text,
        session_id: session.hubSessionId,
        cost_usd: result.usage?.totalCost,
        duration_ms: result.durationMs,
        usage: {
          input_tokens: result.usage?.inputTokens ?? 0,
          output_tokens: result.usage?.outputTokens ?? 0,
          cache_creation_input_tokens: result.usage?.cacheWriteTokens,
          cache_read_input_tokens: result.usage?.cacheReadTokens,
        },
        hasToolUse: false,
        completedToolExchanges,
        ...(completedTerminal ? { terminalError: completedTerminal } : {}),
      };
      if (completedTerminal) {
        callbacks?.onError?.(
          new HostToolTerminalError(
            completedTerminal.code,
            completedTerminal.message,
            completedToolExchanges
          )
        );
      } else {
        callbacks?.onFinal?.({ content: result.text, toolUseBlocks: [] });
      }
      return promptResult;
    } catch (error) {
      const inFlightAtInterruption = [...attempt.inFlightTools];
      if (inFlightAtInterruption.length > 0) {
        if (!attempt.signal.aborted) {
          attemptController.abort(
            error instanceof Error
              ? error
              : new ModelRunnerError('Cline Hub tool transport was interrupted', 'crash', false)
          );
        }
        await this.waitForToolSettlement(inFlightAtInterruption);
      }
      const completedToolExchanges = [...attempt.completed.values()];
      const completedTerminal =
        attempt.terminalResult?.terminalCode && attempt.terminalResult.abort
          ? {
              code: attempt.terminalResult.terminalCode,
              message: attempt.terminalResult.content,
            }
          : completedCodeActTerminalError(completedToolExchanges);
      if (completedTerminal) {
        throw new HostToolTerminalError(
          completedTerminal.code,
          completedTerminal.message,
          completedToolExchanges
        );
      }
      if (attempt.terminalResult?.abort || attempt.terminalResult?.stop) {
        throw new HostToolAbortError(
          'MAMA host tool aborted the active Cline run',
          completedToolExchanges
        );
      }
      if (completedCodeActMutationWasObserved(completedToolExchanges)) {
        throw new McpCompletedMutationInterruptedError(completedToolExchanges);
      }
      if (inFlightAtInterruption.length > 0) {
        const unresolvedIds = [...attempt.pendingTools.values()]
          .filter((toolUse) => toolUse.name === CLINE_CODE_ACT_TOOL_NAME)
          .map((toolUse) => toolUse.id);
        throw new McpResultMissingError(
          unresolvedIds.length > 0 ? unresolvedIds : [...attempt.claimedToolCallIds]
        );
      }
      throw error;
    } finally {
      ownerSignal?.removeEventListener('abort', abortOwner);
      unsubscribe();
      if (session.activeAttempt === attempt) {
        session.activeAttempt = undefined;
      }
      if (attempt.signal.aborted) {
        if (this.sessions.get(routeId) === session) {
          this.sessions.delete(routeId);
          this.removeStableRoute(routeId);
          this.markRouteForRebuild(routeId);
        }
        void runtime.client.stop(session.hubSessionId).catch(() => undefined);
      }
    }
  }

  private async waitForToolSettlement(inFlight: readonly Promise<void>[]): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolvePromise) => {
      timeoutHandle = setTimeout(resolvePromise, CLINE_MUTATION_SETTLEMENT_GRACE_MS);
      timeoutHandle.unref();
    });
    await Promise.race([Promise.all(inFlight).then(() => undefined), timeout]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  private async startHubSession(
    runtime: ClineHubRuntime,
    routeId: string,
    model: string,
    systemPrompt: string,
    policyFingerprint: string | undefined,
    bridge: HostToolBridge | undefined,
    projectedToolFingerprint: string,
    requestTimeout: number | undefined,
    allowedTools: readonly string[],
    disallowedTools: readonly string[],
    allowSpawnAgent: boolean,
    allowAgentTeams: boolean,
    deadlineSignal: AbortSignal
  ): Promise<ClineSessionRecord> {
    const session: ClineSessionRecord = {
      routeId,
      hubSessionId: '',
      model,
      policyFingerprint,
      toolFingerprint: projectedToolFingerprint,
      lastActiveAt: Date.now(),
    };
    const tools = (bridge?.tools ?? []).map((definition) =>
      this.createProjectedTool(runtime, session, definition, requestTimeout)
    );
    const provider = this.options.provider ?? 'cline';
    const cwd = this.options.cwd ?? process.cwd();
    const toolPolicies = buildToolPolicies(bridge, allowedTools, disallowedTools);
    const hasProjectedTools = (bridge?.tools.length ?? 0) > 0;
    const hasNativeTools = allowedTools.includes('*') || allowedTools.length > 0;
    const startPromise = runtime.client.start({
      source: runtime.source,
      interactive: true,
      config: {
        providerId: provider,
        modelId: model,
        apiKey: runtime.apiKey,
        cwd,
        workspaceRoot: cwd,
        systemPrompt,
        enableTools: hasNativeTools || hasProjectedTools,
        enableSpawnAgent: allowSpawnAgent,
        enableAgentTeams: allowAgentTeams,
        disableMcpSettingsTools:
          !allowedTools.includes('*') && !allowedTools.some(isClineMcpToolGrant),
        toolPolicies,
      },
      localRuntime: { extraTools: tools },
      sessionMetadata: {
        source: 'mama-os',
        routeId,
        policyFingerprint,
      },
    });
    let started: { sessionId: string };
    try {
      started = await raceWithAbort(startPromise, deadlineSignal);
    } catch (error) {
      if (deadlineSignal.aborted) {
        void startPromise
          .then((lateSession) => runtime.client.stop(lateSession.sessionId))
          .catch(() => undefined);
      }
      throw error;
    }
    if (!started.sessionId?.trim()) {
      throw new Error('Cline Hub returned an empty session id');
    }
    session.hubSessionId = started.sessionId.trim();
    return session;
  }

  private createProjectedTool(
    runtime: ClineHubRuntime,
    session: ClineSessionRecord,
    definition: HostToolDefinition,
    requestTimeout: number | undefined
  ): unknown {
    const exposedName =
      definition.name === MAMA_CODE_ACT_TOOL_NAME ? CLINE_CODE_ACT_TOOL_NAME : definition.name;
    return runtime.createTool({
      name: exposedName,
      description: definition.description,
      inputSchema: { ...definition.inputSchema },
      timeoutMs: Math.max(requestTimeout ?? this.options.requestTimeout ?? 600_000, 310_000),
      retryable: false,
      maxRetries: 0,
      execute: async (input, context) => {
        const attempt = session.activeAttempt;
        const bridge = attempt?.bridge;
        if (!attempt || !bridge) {
          throw new Error(`MAMA bridge is not active for Cline session ${session.hubSessionId}`);
        }
        if (
          attempt.terminalResult?.abort ||
          attempt.terminalResult?.stop ||
          attempt.terminalResult?.terminalCode
        ) {
          throw new Error('MAMA host-tool attempt is already sealed');
        }
        const streamedToolUse = [...attempt.pendingTools.values()].find(
          (toolUse) => toolUse.name === exposedName && !attempt.claimedToolCallIds.has(toolUse.id)
        );
        const callId = context.toolCallId?.trim() || streamedToolUse?.id || randomUUID();
        attempt.claimedToolCallIds.add(callId);
        const signal = combineSignals(context.signal, attempt.signal);
        let settleTool = (): void => undefined;
        const settlement = new Promise<void>((resolvePromise) => {
          settleTool = resolvePromise;
        });
        attempt.inFlightTools.add(settlement);
        try {
          const result = await bridge.execute({
            callId,
            name: definition.name,
            input,
            signal,
          });
          attempt.executedToolCallIds.add(callId);
          const exchange: CompletedToolExchange = {
            toolUse: {
              type: 'tool_use',
              id: callId,
              name: exposedName,
              input,
            },
            toolResult: {
              type: 'tool_result',
              tool_use_id: callId,
              content: result.content,
              is_error: result.isError,
            },
          };
          attempt.completed.set(callId, exchange);
          if (result.terminalCode || result.abort || result.stop) {
            attempt.terminalResult = result;
            void runtime.client
              .abort(session.hubSessionId, new Error('MAMA host tool sealed run'))
              .catch(() => undefined);
          }
          if (result.isError) {
            throw new Error('MAMA projected tool returned an error');
          }
          return result.content;
        } finally {
          settleTool();
          attempt.inFlightTools.delete(settlement);
        }
      },
    });
  }

  private processHubEvent(
    raw: unknown,
    session: ClineSessionRecord,
    attempt: ActiveAttempt,
    pendingTools: Map<string, ToolUseBlock>,
    callbacks: PromptCallbacks | undefined
  ): void {
    if (!isRecord(raw) || raw.type !== 'agent_event' || !isRecord(raw.payload)) {
      return;
    }
    if (
      stringValue(raw.payload, 'sessionId') !== session.hubSessionId ||
      !isRecord(raw.payload.event)
    ) {
      return;
    }
    const event = raw.payload.event;
    const eventType = stringValue(event, 'type');
    const contentType = stringValue(event, 'contentType');
    if (eventType === 'content_start' && contentType === 'text') {
      const text = stringValue(event, 'text');
      if (text) {
        callbacks?.onDelta?.(text);
      }
      return;
    }
    if (contentType !== 'tool') {
      return;
    }
    const toolCallId = stringValue(event, 'toolCallId');
    if (!toolCallId) {
      return;
    }
    if (eventType === 'content_start') {
      const toolName = stringValue(event, 'toolName');
      if (!toolName) {
        return;
      }
      const input = isRecord(event.input) ? event.input : {};
      pendingTools.set(toolCallId, {
        type: 'tool_use',
        id: toolCallId,
        name: toolName,
        input,
      });
      callbacks?.onToolUse?.(toolName, input);
      return;
    }
    if (eventType !== 'content_end') {
      return;
    }
    const toolUse = pendingTools.get(toolCallId);
    if (!toolUse) {
      return;
    }
    const isError = typeof event.error === 'string' && event.error.length > 0;
    if (attempt.executedToolCallIds.has(toolCallId) && !attempt.completed.has(toolCallId)) {
      attempt.completed.set(toolCallId, {
        toolUse,
        toolResult: {
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: normalizeToolOutput(isError ? event.error : event.output),
          is_error: isError,
        },
      });
    }
    pendingTools.delete(toolCallId);
    attempt.claimedToolCallIds.delete(toolCallId);
    callbacks?.onToolComplete?.(toolUse.name, toolCallId, isError);
  }

  private removeStableRoute(routeId: string): void {
    for (const [stableRouteId, mappedRouteId] of this.stableRoutes) {
      if (mappedRouteId === routeId) {
        this.stableRoutes.delete(stableRouteId);
      }
    }
  }

  private markRouteForRebuild(routeId: string): void {
    this.routesRequiringRebuild.delete(routeId);
    this.routesRequiringRebuild.add(routeId);
    while (this.routesRequiringRebuild.size > this.maxSessions) {
      const oldest = this.routesRequiringRebuild.values().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.routesRequiringRebuild.delete(oldest);
    }
  }

  private async retireRoute(
    runtime: ClineHubRuntime,
    routeId: string,
    signal: AbortSignal
  ): Promise<void> {
    const session = this.sessions.get(routeId);
    if (!session) {
      return;
    }
    await raceWithAbort(
      runtime.client.stop(session.hubSessionId).catch(() => undefined),
      signal
    );
    this.sessions.delete(routeId);
    this.removeStableRoute(routeId);
  }

  private async retireStaleSessions(
    runtime: ClineHubRuntime,
    protectedRouteId: string,
    signal: AbortSignal
  ): Promise<void> {
    const expiry = Date.now() - this.sessionTtlMs;
    const expired = [...this.sessions.entries()]
      .filter(
        ([routeId, session]) =>
          routeId !== protectedRouteId &&
          !this.activeRoutes.has(routeId) &&
          !session.activeAttempt &&
          session.lastActiveAt < expiry
      )
      .map(([routeId]) => routeId);
    for (const routeId of expired) {
      await this.retireRoute(runtime, routeId, signal);
    }

    if (this.sessions.has(protectedRouteId)) {
      return;
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()]
        .filter(([routeId, session]) => !this.activeRoutes.has(routeId) && !session.activeAttempt)
        .sort((left, right) => left[1].lastActiveAt - right[1].lastActiveAt)[0]?.[0];
      if (!oldest) {
        return;
      }
      await this.retireRoute(runtime, oldest, signal);
    }
  }

  private normalizeError(error: unknown): Error {
    if (
      error instanceof ModelRunnerError ||
      error instanceof HostToolAbortError ||
      error instanceof HostToolTerminalError ||
      error instanceof McpCompletedMutationInterruptedError ||
      error instanceof McpResultMissingError
    ) {
      return error;
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    const failure = safeProviderFailure(rawMessage, 'exception');
    return new ModelRunnerError(failure.message, failure.code, failure.code !== 'auth_failure');
  }

  getSessionPolicyStatus(options: PromptOptions): SessionPolicyStatus {
    const routeId = options.sessionId ?? options.sessionKey ?? this.sessionId;
    const session = this.sessions.get(routeId);
    if (!session) {
      return 'missing';
    }
    const allowedTools = options.allowedTools ?? this.options.allowedTools ?? [];
    const disallowedTools = options.disallowedTools ?? this.options.disallowedTools ?? [];
    return session.policyFingerprint === options.sessionPolicyFingerprint &&
      session.toolFingerprint ===
        toolFingerprint(
          options.hostToolBridge,
          allowedTools,
          disallowedTools,
          options.allowSpawnAgent ?? this.options.allowSpawnAgent ?? false,
          options.allowAgentTeams ?? this.options.allowAgentTeams ?? false
        )
      ? 'compatible'
      : 'mismatch';
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async sendMessage(content: string, callbacks?: PromptCallbacks): Promise<PromptResult> {
    return this.prompt(content, callbacks, { resumeSession: true });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isHealthy(): boolean {
    return !this.stopped;
  }

  isReady(): boolean {
    return !this.stopped;
  }

  getMetrics(): RunnerMetrics {
    return {
      requestCount: this.requestCount,
      failureCount: this.failureCount,
      avgLatencyMs: this.requestCount > 0 ? Math.round(this.totalLatencyMs / this.requestCount) : 0,
      lastRequestAt: this.lastRequestAt,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const pendingRuntime = this.runtimePromise;
    const runtime = pendingRuntime ? await this.waitForCleanup(pendingRuntime, 1_000, null) : null;
    if (!runtime) {
      this.sessions.clear();
      this.stableRoutes.clear();
      this.routesRequiringRebuild.clear();
      if (pendingRuntime) {
        void pendingRuntime
          .then((lateRuntime) => this.disposeRuntimeOnce(lateRuntime, 'mama_shutdown'))
          .catch(() => undefined);
      }
      return;
    }
    const sessions = [...this.sessions.values()];
    const shutdownError = new ModelRunnerError(
      'Cline Hub adapter is shutting down',
      'crash',
      false
    );
    for (const session of sessions) {
      session.activeAttempt?.controller.abort(shutdownError);
      if (session.activeAttempt) {
        void runtime.client.abort(session.hubSessionId, shutdownError).catch(() => undefined);
      }
    }
    const inFlight = sessions.flatMap((session) => [
      ...(session.activeAttempt?.inFlightTools ?? []),
    ]);
    if (inFlight.length > 0) {
      await this.waitForToolSettlement(inFlight);
    }
    this.sessions.clear();
    this.stableRoutes.clear();
    this.routesRequiringRebuild.clear();
    this.activeRoutes.clear();
    void Promise.allSettled(sessions.map((session) => runtime.client.stop(session.hubSessionId)));
    await this.waitForCleanup(this.disposeRuntimeOnce(runtime, 'mama_shutdown'), 1_000, undefined);
  }

  private async waitForCleanup<T, F>(
    operation: Promise<T>,
    timeoutMs: number,
    fallback: F
  ): Promise<T | F> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<F>((resolvePromise) => {
      timeoutHandle = setTimeout(() => resolvePromise(fallback), timeoutMs);
      timeoutHandle.unref();
    });
    const result = await Promise.race([operation, timeout]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    return result;
  }
}
