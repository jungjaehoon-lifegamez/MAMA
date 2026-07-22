import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import {
  HostToolTerminalError,
  isHostToolTerminalCode,
  type HostToolBridge,
  type HostToolDefinition,
  type PromptResult,
  type SessionPolicyStatus,
} from './model-runner.js';
import type { PromptCallbacks } from './types.js';
import {
  buildCodexAppServerLaunchConfig,
  buildMAMACodexAppServerConfig,
  type CodexAppServerLaunchConfig,
} from './codex-home.js';
import { CodexThreadRegistry, fingerprintText } from './codex-thread-registry.js';

export interface CodexAppServerProcessOptions {
  sessionKey: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  command?: string;
  requestTimeout?: number;
  codexHome?: string;
  isolatedHome?: string;
  registryRoot?: string;
  mcpConfigPath?: string;
  /** Stable identity/rules fingerprint; dynamic conversation context must be excluded. */
  policyFingerprint?: string;
}

export interface CodexAppServerPromptOptions {
  sessionKey?: string;
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  requestTimeout?: number;
  policyFingerprint?: string;
  resumeSession?: boolean;
  hostToolBridge?: HostToolBridge;
}

type JsonObject = Record<string, unknown>;

interface JsonRpcMessage extends JsonObject {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingTurn {
  threadId: string;
  turnId?: string;
  chunks: string[];
  usage: PromptResult['usage'];
  timer: NodeJS.Timeout;
  requestTimeout: number;
  queuedNotifications: Array<{ method: string; params: unknown }>;
  queuedToolRequests: ServerToolRequest[];
  toolCallQueue: Promise<void>;
  toolCallResults: Map<string, HostToolCallState>;
  stoppingCallIds: Set<string>;
  hostToolBridge?: HostToolBridge;
  abortController: AbortController;
  intentionalStop: boolean;
  abortError?: Error;
  settledTerminalError?: HostToolTerminalError;
  onDelta?: (text: string) => void;
  resolve: (result: PromptResult) => void;
  reject: (error: Error) => void;
}

interface TurnStartReconciliation {
  promise: Promise<void>;
  resolve: () => void;
  recoveryTimer?: NodeJS.Timeout;
}

interface LateTurnStart {
  threadId: string;
  requestTimeout: number;
  reconciliation: TurnStartReconciliation;
}

interface ServerToolRequest {
  child: ChildProcessWithoutNullStreams;
  id: number | string;
  params: unknown;
}

interface HostToolExecution {
  result: JsonObject;
  stop: boolean;
  abortError?: Error;
}

interface HostToolCallState {
  identity: string;
  execution: Promise<HostToolExecution>;
}

interface SessionPolicy {
  sessionKey: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  requestTimeout: number;
  policyFingerprint?: string;
  hostToolBridge?: HostToolBridge;
}

interface SessionState {
  threadId: string;
  bootstrapPending: boolean;
}

const DEFAULT_TIMEOUT = 300_000;
const STOP_GRACE_MS = 200;
const STDERR_LIMIT = 4_000;
const CLIENT_INFO = { name: 'mama-codex-app-server', version: '1.0.0' };
const TURN_STATUSES = new Set(['completed', 'interrupted', 'failed', 'inProgress']);
const TURN_ITEM_VIEWS = new Set(['notLoaded', 'summary', 'full']);
const APPROVAL_REVIEWERS = new Set(['user', 'auto_review', 'guardian_subagent']);
const OVERLOADED_ERROR_CODE = -32001;
const OVERLOAD_RETRY_LIMIT = 4;
const OVERLOAD_RETRY_BASE_MS = 25;
const TURN_START_RECONCILE_GRACE_MS = 250;

class CodexAppServerRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'CodexAppServerRpcError';
    this.code = code;
  }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  const record = object(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableJson(record[key])])
  );
}

function deepFreeze(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    Object.freeze(value);
    return;
  }
  const record = object(value);
  if (record) {
    for (const item of Object.values(record)) {
      deepFreeze(item);
    }
    Object.freeze(record);
  }
}

function snapshotHostToolBridge(bridge: HostToolBridge | undefined): HostToolBridge | undefined {
  if (!bridge) {
    return undefined;
  }
  const tools = bridge.tools
    .map((tool) => stableJson(tool) as HostToolDefinition)
    .sort((left, right) => left.name.localeCompare(right.name));
  deepFreeze(tools);
  const execute = bridge.execute.bind(bridge);
  return Object.freeze({ tools, execute });
}

function errorMessage(value: unknown, fallback: string): string {
  const record = object(value);
  return typeof record?.message === 'string' && record.message ? record.message : fallback;
}

function stringField(record: JsonObject, name: string, context: string): string {
  const value = record[name];
  if (typeof value !== 'string') {
    throw new Error(`Codex app-server returned malformed ${context}.${name}`);
  }
  return value;
}

function nullableStringField(record: JsonObject, name: string, context: string): void {
  const value = record[name];
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Codex app-server returned malformed ${context}.${name}`);
  }
}

function nullableNumberField(record: JsonObject, name: string, context: string): void {
  const value = record[name];
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`Codex app-server returned malformed ${context}.${name}`);
  }
}

function validateTurn(value: unknown, context: string): JsonObject {
  const turn = object(value);
  if (!turn) {
    throw new Error(`Codex app-server returned malformed ${context}`);
  }
  stringField(turn, 'id', context);
  if (!Array.isArray(turn.items) || !TURN_ITEM_VIEWS.has(String(turn.itemsView))) {
    throw new Error(`Codex app-server returned malformed ${context} items`);
  }
  if (!TURN_STATUSES.has(String(turn.status))) {
    throw new Error(`Codex app-server returned malformed ${context}.status`);
  }
  if (turn.error !== null) {
    const error = object(turn.error);
    if (
      !error ||
      typeof error.message !== 'string' ||
      error.codexErrorInfo === undefined ||
      (error.additionalDetails !== null && typeof error.additionalDetails !== 'string')
    ) {
      throw new Error(`Codex app-server returned malformed ${context}.error`);
    }
  }
  nullableNumberField(turn, 'startedAt', context);
  nullableNumberField(turn, 'completedAt', context);
  nullableNumberField(turn, 'durationMs', context);
  return turn;
}

function validateThread(value: unknown): JsonObject {
  const thread = object(value);
  if (!thread) {
    throw new Error('Codex app-server returned malformed thread');
  }
  for (const field of ['id', 'sessionId', 'preview', 'modelProvider', 'cwd', 'cliVersion']) {
    stringField(thread, field, 'thread');
  }
  for (const field of [
    'forkedFromId',
    'parentThreadId',
    'path',
    'threadSource',
    'agentNickname',
    'agentRole',
    'name',
  ]) {
    nullableStringField(thread, field, 'thread');
  }
  if (typeof thread.ephemeral !== 'boolean') {
    throw new Error('Codex app-server returned malformed thread.ephemeral');
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof thread[field] !== 'number' || !Number.isFinite(thread[field])) {
      throw new Error(`Codex app-server returned malformed thread.${field}`);
    }
  }
  nullableNumberField(thread, 'recencyAt', 'thread');
  const status = object(thread.status);
  if (
    !status ||
    !['notLoaded', 'idle', 'systemError', 'active'].includes(String(status.type)) ||
    (status.type === 'active' && !Array.isArray(status.activeFlags))
  ) {
    throw new Error('Codex app-server returned malformed thread.status');
  }
  const sourceValid = typeof thread.source === 'string' || object(thread.source) !== undefined;
  if (
    !sourceValid ||
    (thread.gitInfo !== null && !object(thread.gitInfo)) ||
    !Array.isArray(thread.turns)
  ) {
    throw new Error('Codex app-server returned malformed thread metadata');
  }
  for (const turn of thread.turns) {
    validateTurn(turn, 'thread.turns[]');
  }
  return thread;
}

function shaFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function managedFileSignature(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicPrivateWrite(path: string, value: string): void {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function copyAuthAtomically(source: string, destination: string): void {
  if (
    !existsSync(source) ||
    statSync(source).size === 0 ||
    resolve(source) === resolve(destination)
  ) {
    return;
  }
  ensurePrivateDirectory(dirname(destination));
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
}

function configuredSecretValues(launch: CodexAppServerLaunchConfig): Set<string> {
  const names = new Set<string>();
  const addJsonString = (source: string): void => {
    try {
      const name = JSON.parse(source) as unknown;
      if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        names.add(name);
      }
    } catch (error: unknown) {
      throw new Error('Codex app-server launch config contained malformed environment quoting', {
        cause: error,
      });
    }
  };

  for (const argument of launch.args) {
    for (const match of argument.matchAll(/env_vars\s*=\s*\[([^\]]*)\]/g)) {
      for (const quoted of match[1].matchAll(/"(?:\\.|[^"\\])*"/g)) {
        addJsonString(quoted[0]);
      }
    }
    for (const match of argument.matchAll(/bearer_token_env_var\s*=\s*("(?:\\.|[^"\\])*")/g)) {
      addJsonString(match[1]);
    }
    for (const match of argument.matchAll(/env_http_headers\s*=\s*\{([^}]*)\}/g)) {
      for (const binding of match[1].matchAll(/=\s*("(?:\\.|[^"\\])*")/g)) {
        addJsonString(binding[1]);
      }
    }
  }

  const values = new Set<string>();
  for (const name of names) {
    const value = launch.env[name];
    if (typeof value === 'string' && value.length > 0) {
      values.add(value);
    }
  }
  return values;
}

export class CodexAppServerProcess {
  private readonly options: Required<
    Pick<
      CodexAppServerProcessOptions,
      | 'sessionKey'
      | 'model'
      | 'systemPrompt'
      | 'cwd'
      | 'sandbox'
      | 'command'
      | 'requestTimeout'
      | 'codexHome'
      | 'isolatedHome'
      | 'registryRoot'
    >
  > & { mcpConfigPath?: string; policyFingerprint?: string };
  private readonly registry: CodexThreadRegistry;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: ReadlineInterface | undefined;
  private stderr: ReadlineInterface | undefined;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private lateTurnStarts = new Map<number, LateTurnStart>();
  private turnStartReconciliations = new Map<string, TurnStartReconciliation>();
  private turns = new Map<string, PendingTurn>();
  private sessions = new Map<string, SessionState>();
  private sessionQueues = new Map<string, Promise<void>>();
  private connectionQueue: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private stopped = false;
  private stderrTail = '';
  private secrets = new Set<string>();
  private authFingerprint: string | undefined;
  private authFingerprintInitialized = false;
  private authSourceSignature: string | undefined;
  private managedConfigFingerprint: string | undefined;
  private managedConfigSignature: string | undefined;
  private secretLaunchFingerprint: string | undefined;
  private secretLaunchFingerprintInitialized = false;
  private killTimer: NodeJS.Timeout | undefined;
  private finalKillTimer: NodeJS.Timeout | undefined;

  constructor(options: CodexAppServerProcessOptions) {
    const mamaRoot = join(homedir(), '.mama');
    this.options = {
      ...options,
      command: options.command ?? 'codex',
      requestTimeout: options.requestTimeout ?? DEFAULT_TIMEOUT,
      codexHome: resolve(options.codexHome ?? join(mamaRoot, '.codex')),
      isolatedHome: resolve(options.isolatedHome ?? join(mamaRoot, 'codex-runtime', 'home')),
      registryRoot: resolve(options.registryRoot ?? join(mamaRoot, 'codex-runtime', 'threads')),
      cwd: resolve(options.cwd),
    };
    ensurePrivateDirectory(dirname(this.options.registryRoot));
    this.registry = new CodexThreadRegistry({ rootDir: this.options.registryRoot });
  }

  async prompt(
    text: string,
    callbacks?: PromptCallbacks,
    overrides: CodexAppServerPromptOptions = {}
  ): Promise<PromptResult> {
    if (this.stopped) {
      throw new Error('Codex app-server process is stopped');
    }
    const session = this.resolveSessionPolicy(overrides);
    return this.enqueueSession(session.sessionKey, async () => {
      try {
        if (this.stopped) {
          throw new Error('Codex app-server process is stopped');
        }
        const launch = buildCodexAppServerLaunchConfig(this.options.mcpConfigPath, process.env);
        if (overrides.resumeSession === false) {
          this.registry.remove(session.sessionKey);
          this.sessions.delete(session.sessionKey);
        }
        this.assertRegistryPolicy(session, launch);
        await this.prepareConnection(launch, session.requestTimeout);
        let state = this.sessions.get(session.sessionKey);
        if (!state?.threadId) {
          try {
            state = await this.openThread(session, launch);
          } catch (error: unknown) {
            if (this.child && !this.shutdownPromise) {
              await this.shutdown(this.toError(error));
            }
            throw error;
          }
          this.sessions.set(session.sessionKey, state);
        }
        const reconciliation = this.turnStartReconciliations.get(state.threadId);
        if (reconciliation) {
          await reconciliation.promise;
          await this.prepareConnection(launch, session.requestTimeout);
          state = this.sessions.get(session.sessionKey);
          if (!state?.threadId) {
            state = await this.openThread(session, launch);
            this.sessions.set(session.sessionKey, state);
          }
        }
        const turnText =
          state.bootstrapPending && session.systemPrompt
            ? `<system-reminder>\nFresh MAMA runtime context after resuming this durable thread:\n${session.systemPrompt.replace(/<\/system-reminder>/gi, '')}\n</system-reminder>\n\n${text}`
            : text;
        const result = await this.startTurn(
          state.threadId,
          turnText,
          callbacks,
          session.requestTimeout,
          session.hostToolBridge
        );
        state.bootstrapPending = false;
        return result;
      } catch (error: unknown) {
        if (
          error instanceof CodexAppServerRpcError &&
          error.code !== OVERLOADED_ERROR_CODE &&
          this.child &&
          !this.shutdownPromise
        ) {
          await this.shutdown(error);
        }
        if (this.shutdownPromise) {
          await this.shutdownPromise;
        }
        throw error;
      }
    });
  }

  async reset(sessionKey = this.options.sessionKey): Promise<void> {
    await this.enqueueSession(sessionKey, async () => {
      this.registry.remove(sessionKey);
      this.sessions.delete(sessionKey);
    });
  }

  getSessionPolicyStatus(overrides: CodexAppServerPromptOptions = {}): SessionPolicyStatus {
    const session = this.resolveSessionPolicy(overrides);
    const record = this.registry.load(session.sessionKey);
    if (!record) {
      return 'missing';
    }
    const launch = buildCodexAppServerLaunchConfig(this.options.mcpConfigPath, process.env);
    return this.registryPolicyMatches(record, session, launch) ? 'compatible' : 'mismatch';
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.shutdown(new Error('Codex app-server process stopped'));
  }

  getThreadId(sessionKey = this.options.sessionKey): string | undefined {
    return this.sessions.get(sessionKey)?.threadId || undefined;
  }

  getStatus(): {
    running: boolean;
    childPid?: number;
    pendingRequestCount: number;
    hasActiveTurn: boolean;
    stdoutListenerCount: number;
    stderrListenerCount: number;
    shutdownTimerActive: boolean;
  } {
    return {
      running: this.child !== undefined,
      childPid: this.child?.pid,
      pendingRequestCount: this.pending.size,
      hasActiveTurn: this.turns.size > 0,
      stdoutListenerCount: this.stdout?.listenerCount('line') ?? 0,
      stderrListenerCount: this.stderr?.listenerCount('line') ?? 0,
      shutdownTimerActive: this.killTimer !== undefined || this.finalKillTimer !== undefined,
    };
  }

  private resolveSessionPolicy(overrides: CodexAppServerPromptOptions): SessionPolicy {
    const hostToolBridge = snapshotHostToolBridge(overrides.hostToolBridge);
    return {
      sessionKey: overrides.sessionKey ?? this.options.sessionKey,
      model: overrides.model ?? this.options.model,
      systemPrompt: overrides.systemPrompt ?? this.options.systemPrompt,
      cwd: resolve(overrides.cwd ?? this.options.cwd),
      sandbox: overrides.sandbox ?? this.options.sandbox,
      requestTimeout: overrides.requestTimeout ?? this.options.requestTimeout,
      policyFingerprint: overrides.policyFingerprint ?? this.options.policyFingerprint,
      hostToolBridge,
    };
  }

  private enqueueSession<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.sessionQueues.set(sessionKey, tail);
    void tail.finally(() => {
      if (this.sessionQueues.get(sessionKey) === tail) {
        this.sessionQueues.delete(sessionKey);
      }
    });
    return result;
  }

  private async prepareConnection(
    launch: CodexAppServerLaunchConfig,
    requestTimeout: number
  ): Promise<void> {
    const operation = this.connectionQueue.then(async () => {
      if (this.stopped) {
        throw new Error('Codex app-server process is stopped');
      }
      if (this.shutdownPromise) {
        await this.shutdownPromise;
      }
      if (this.stopped) {
        throw new Error('Codex app-server process is stopped');
      }
      const refreshed = this.prepareManagedFiles(launch);
      if (refreshed && this.child) {
        await this.restart();
      }
      try {
        await this.ensureStarted(launch, requestTimeout);
      } catch (error: unknown) {
        if (this.child && !this.shutdownPromise) {
          await this.shutdown(this.toError(error));
        }
        throw error;
      }
    });
    this.connectionQueue = operation.catch(() => undefined);
    await operation;
  }

  private assertRegistryPolicy(session: SessionPolicy, launch: CodexAppServerLaunchConfig): void {
    const record = this.registry.load(session.sessionKey);
    if (!record) {
      return;
    }
    if (!this.registryPolicyMatches(record, session, launch)) {
      throw new Error('Codex app-server thread policy mismatch; reset the session explicitly');
    }
  }

  private registryPolicyMatches(
    record: NonNullable<ReturnType<CodexThreadRegistry['load']>>,
    session: SessionPolicy,
    launch: CodexAppServerLaunchConfig
  ): boolean {
    return (
      record.model === session.model &&
      record.cwd === session.cwd &&
      record.systemPromptFingerprint === this.policyFingerprint(session) &&
      record.mcpConfigFingerprint === launch.fingerprint
    );
  }

  private prepareManagedFiles(launch: CodexAppServerLaunchConfig): boolean {
    ensurePrivateDirectory(this.options.codexHome);
    ensurePrivateDirectory(this.options.isolatedHome);
    const configPath = join(this.options.codexHome, 'config.toml');
    const config = buildMAMACodexAppServerConfig();
    const configFingerprint = fingerprintText(config);
    const configSignature = managedFileSignature(configPath);
    if (
      this.managedConfigFingerprint !== configFingerprint ||
      this.managedConfigSignature !== configSignature
    ) {
      if (configSignature === undefined || shaFile(configPath) !== configFingerprint) {
        atomicPrivateWrite(configPath, config);
      }
      this.managedConfigFingerprint = configFingerprint;
      this.managedConfigSignature = managedFileSignature(configPath);
    }
    const sourceAuth = join(homedir(), '.codex', 'auth.json');
    const destinationAuth = join(this.options.codexHome, 'auth.json');
    const sourceStat = existsSync(sourceAuth) ? statSync(sourceAuth) : undefined;
    const sourceSignature =
      sourceStat && sourceStat.size > 0
        ? `${realpathSync(sourceAuth)}:${sourceStat.size}:${sourceStat.mtimeMs}:${sourceStat.ctimeMs}`
        : undefined;
    let sourceFingerprint = this.authFingerprint;
    if (
      !this.authFingerprintInitialized ||
      this.authSourceSignature !== sourceSignature ||
      (sourceSignature !== undefined && !existsSync(destinationAuth))
    ) {
      sourceFingerprint = sourceSignature ? shaFile(sourceAuth) : undefined;
      if (
        sourceFingerprint &&
        (!existsSync(destinationAuth) || shaFile(destinationAuth) !== sourceFingerprint)
      ) {
        copyAuthAtomically(sourceAuth, destinationAuth);
      }
    }
    const changed = this.authFingerprintInitialized && this.authFingerprint !== sourceFingerprint;
    this.authFingerprint = sourceFingerprint;
    this.authFingerprintInitialized = true;
    this.authSourceSignature = sourceSignature;
    const secretChanged =
      this.secretLaunchFingerprintInitialized &&
      this.secretLaunchFingerprint !== launch.secretFingerprint;
    if (
      !this.secretLaunchFingerprintInitialized ||
      this.secretLaunchFingerprint !== launch.secretFingerprint
    ) {
      this.secrets = configuredSecretValues(launch);
      this.secretLaunchFingerprint = launch.secretFingerprint;
      this.secretLaunchFingerprintInitialized = true;
    }
    return changed || secretChanged;
  }

  private async ensureStarted(
    launch: CodexAppServerLaunchConfig,
    requestTimeout: number
  ): Promise<void> {
    if (this.child) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.start(launch, requestTimeout);
    }
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async start(launch: CodexAppServerLaunchConfig, requestTimeout: number): Promise<void> {
    const child = spawn(
      this.options.command,
      ['app-server', '--strict-config', '--stdio', ...launch.args],
      {
        cwd: this.options.cwd,
        env: { ...launch.env, HOME: this.options.isolatedHome, CODEX_HOME: this.options.codexHome },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    this.child = child;
    this.stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stdout.on('line', (line) => this.handleLine(child, line));
    this.stderr.on('line', (line) => this.handleStderr(line));
    child.once('error', (error) => this.failProcess(child, error));
    child.once('exit', (code, signal) =>
      this.failProcess(child, new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`))
    );
    const initialized = await this.request(
      'initialize',
      {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      },
      requestTimeout
    );
    const initializeResponse = object(initialized);
    if (
      !initializeResponse ||
      typeof initializeResponse.userAgent !== 'string' ||
      typeof initializeResponse.codexHome !== 'string' ||
      typeof initializeResponse.platformFamily !== 'string' ||
      typeof initializeResponse.platformOs !== 'string'
    ) {
      throw new Error('Codex app-server initialize returned a malformed response');
    }
    if (realpathSync(initializeResponse.codexHome) !== realpathSync(this.options.codexHome)) {
      throw new Error('Codex app-server initialize returned an unexpected CODEX_HOME');
    }
    this.notify('initialized');
  }

  private async openThread(
    session: SessionPolicy,
    launch: CodexAppServerLaunchConfig
  ): Promise<SessionState> {
    const record = this.registry.load(session.sessionKey);
    if (record) {
      const result = object(
        await this.request(
          'thread/resume',
          {
            threadId: record.threadId,
            model: session.model,
            cwd: session.cwd,
            approvalPolicy: 'never',
            sandbox: session.sandbox,
          },
          session.requestTimeout
        )
      );
      this.validateResponsePolicy(result, session);
      this.validateInstructionMetadata(result, session);
      const resumed = validateThread(result?.thread);
      if (typeof resumed?.id !== 'string' || resumed.id !== record.threadId) {
        throw new Error('Codex app-server resumed an unexpected thread');
      }
      return { threadId: record.threadId, bootstrapPending: true };
    }
    const threadStartParams: JsonObject = {
      model: session.model,
      cwd: session.cwd,
      approvalPolicy: 'never',
      sandbox: session.sandbox,
      baseInstructions: session.systemPrompt,
      config: {},
    };
    if (session.hostToolBridge) {
      threadStartParams.dynamicTools = session.hostToolBridge.tools;
    }
    const result = object(
      await this.request('thread/start', threadStartParams, session.requestTimeout)
    );
    this.validateResponsePolicy(result, session);
    this.validateInstructionMetadata(result, session);
    const thread = validateThread(result?.thread);
    if (typeof thread?.id !== 'string' || !thread.id) {
      throw new Error('Codex app-server thread/start returned no thread id');
    }
    this.registry.save({
      sessionKey: session.sessionKey,
      threadId: thread.id,
      model: session.model,
      cwd: session.cwd,
      systemPromptFingerprint: this.policyFingerprint(session),
      mcpConfigFingerprint: launch.fingerprint,
    });
    return { threadId: thread.id, bootstrapPending: false };
  }

  private policyFingerprint(session: SessionPolicy): string {
    const base = session.policyFingerprint ?? fingerprintText(session.systemPrompt);
    const tools = session.hostToolBridge?.tools;
    if (!tools?.length) {
      return base;
    }
    return fingerprintText(`${base}\n${JSON.stringify(tools)}`);
  }

  private validateInstructionMetadata(
    result: JsonObject | undefined,
    session: SessionPolicy
  ): void {
    const sources = result?.instructionSources;
    if (!Array.isArray(sources)) {
      throw new Error('Codex app-server returned malformed instruction sources');
    }
    const managedRoots = [session.cwd, this.options.codexHome].map((root) => realpathSync(root));
    for (const source of sources) {
      if (typeof source !== 'string') {
        throw new Error('Codex app-server returned malformed instruction source');
      }
      let path: string;
      try {
        path = realpathSync(resolve(session.cwd, source));
      } catch (error: unknown) {
        throw new Error('Codex app-server loaded an instruction source outside managed roots', {
          cause: error,
        });
      }
      const allowed = managedRoots.some((root) => {
        const childPath = relative(root, path);
        return (
          childPath === '' ||
          (childPath !== '..' && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath))
        );
      });
      if (!allowed) {
        throw new Error('Codex app-server loaded an instruction source outside managed roots');
      }
    }
  }

  private validateResponsePolicy(result: JsonObject | undefined, session: SessionPolicy): void {
    if (!result) {
      throw new Error('Codex app-server returned a malformed thread response');
    }
    if (
      typeof result.modelProvider !== 'string' ||
      (result.serviceTier !== null && typeof result.serviceTier !== 'string') ||
      !APPROVAL_REVIEWERS.has(String(result.approvalsReviewer)) ||
      (result.reasoningEffort !== null && typeof result.reasoningEffort !== 'string')
    ) {
      throw new Error('Codex app-server returned malformed thread response metadata');
    }
    if (typeof result.model !== 'string' || result.model !== session.model) {
      throw new Error('Codex app-server response model did not match the requested policy');
    }
    if (typeof result.cwd !== 'string' || resolve(result.cwd) !== session.cwd) {
      throw new Error('Codex app-server response cwd did not match the requested policy');
    }
    if (result.approvalPolicy !== 'never') {
      throw new Error('Codex app-server response approval policy was not never');
    }
    const sandbox = object(result.sandbox);
    const expectedSandboxType = {
      'read-only': 'readOnly',
      'workspace-write': 'workspaceWrite',
      'danger-full-access': 'dangerFullAccess',
    }[session.sandbox];
    if (typeof sandbox?.type !== 'string' || sandbox.type !== expectedSandboxType) {
      throw new Error('Codex app-server response sandbox did not match the requested policy');
    }
    if (sandbox.type === 'readOnly' && typeof sandbox.networkAccess !== 'boolean') {
      throw new Error('Codex app-server returned a malformed read-only sandbox policy');
    }
    if (
      sandbox.type === 'workspaceWrite' &&
      (!Array.isArray(sandbox.writableRoots) ||
        typeof sandbox.networkAccess !== 'boolean' ||
        typeof sandbox.excludeTmpdirEnvVar !== 'boolean' ||
        typeof sandbox.excludeSlashTmp !== 'boolean')
    ) {
      throw new Error('Codex app-server returned a malformed workspace-write sandbox policy');
    }
  }

  private startTurn(
    threadId: string,
    text: string,
    callbacks: PromptCallbacks | undefined,
    requestTimeout: number,
    hostToolBridge: HostToolBridge | undefined
  ): Promise<PromptResult> {
    return new Promise<PromptResult>((resolveTurn, rejectTurn) => {
      const abortController = new AbortController();
      const timer = setTimeout(() => {
        const error = new Error(`Codex app-server turn timed out after ${requestTimeout}ms`);
        this.timeoutTurn(threadId, error, requestTimeout);
      }, requestTimeout);
      timer.unref();
      const pendingTurn: PendingTurn = {
        threadId,
        chunks: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        timer,
        requestTimeout,
        queuedNotifications: [],
        queuedToolRequests: [],
        toolCallQueue: Promise.resolve(),
        toolCallResults: new Map(),
        stoppingCallIds: new Set(),
        hostToolBridge,
        abortController,
        intentionalStop: false,
        onDelta: callbacks?.onDelta,
        resolve: resolveTurn,
        reject: rejectTurn,
      };
      this.turns.set(threadId, pendingTurn);
      this.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
        },
        requestTimeout
      )
        .then((value) => {
          const turn = validateTurn(object(value)?.turn, 'turn/start turn');
          if (typeof turn?.id !== 'string' || !turn.id) {
            this.failTurn(threadId, new Error('Codex app-server turn/start returned no turn id'));
            return;
          }
          const activeTurn = this.turns.get(threadId);
          if (activeTurn === pendingTurn) {
            activeTurn.turnId = turn.id;
            const queued = activeTurn.queuedNotifications.splice(0);
            for (const notification of queued) {
              this.handleNotification(notification.method, notification.params);
            }
            const queuedToolRequests = activeTurn.queuedToolRequests.splice(0);
            for (const request of queuedToolRequests) {
              this.handleDynamicToolRequest(request, activeTurn);
            }
          } else if (this.turnStartReconciliations.has(threadId)) {
            void this.reconcileAcknowledgedTurn(threadId, turn.id, requestTimeout);
          }
        })
        .catch((error: unknown) => {
          if (this.turns.get(threadId) === pendingTurn) {
            this.failTurn(threadId, this.toError(error));
            return;
          }
          const reconciliation = this.turnStartReconciliations.get(threadId);
          if (!reconciliation) {
            return;
          }
          if (error instanceof CodexAppServerRpcError) {
            this.completeTurnStartReconciliation(threadId, reconciliation);
          } else if (!reconciliation.recoveryTimer) {
            void this.shutdown(this.toError(error)).finally(() => {
              this.completeTurnStartReconciliation(threadId, reconciliation);
            });
          }
        });
    });
  }

  private async request(
    method: string,
    params: unknown,
    requestTimeout = this.options.requestTimeout
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(method, params, requestTimeout);
      } catch (error: unknown) {
        if (
          !(error instanceof CodexAppServerRpcError) ||
          error.code !== OVERLOADED_ERROR_CODE ||
          attempt >= OVERLOAD_RETRY_LIMIT - 1
        ) {
          throw error;
        }
        const delay = OVERLOAD_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 10);
        await new Promise<void>((resolveDelay) => {
          const timer = setTimeout(resolveDelay, delay);
          timer.unref();
        });
      }
    }
  }

  private requestOnce(method: string, params: unknown, requestTimeout: number): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server stdin is not writable'));
    }
    const id = ++this.nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server ${method} timed out after ${requestTimeout}ms`);
        const threadId = method === 'turn/start' ? object(params)?.threadId : undefined;
        if (typeof threadId === 'string' && threadId) {
          const reconciliation = this.getOrCreateTurnStartReconciliation(threadId);
          reconciliation.recoveryTimer = setTimeout(
            () => {
              this.lateTurnStarts.delete(id);
              void this.shutdown(error).finally(() => {
                this.completeTurnStartReconciliation(threadId, reconciliation);
              });
            },
            Math.max(requestTimeout, TURN_START_RECONCILE_GRACE_MS)
          );
          reconciliation.recoveryTimer.unref();
          this.lateTurnStarts.set(id, { threadId, requestTimeout, reconciliation });
          rejectRequest(error);
          return;
        }
        rejectRequest(error);
        void this.shutdown(error);
      }, requestTimeout);
      timer.unref();
      this.pending.set(id, { method, timer, resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    const message =
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child || !line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = object(parsed);
      if (!record) {
        throw new Error('not an object');
      }
      message = record as JsonRpcMessage;
    } catch {
      const error = new Error('Codex app-server emitted malformed JSON');
      this.failAll(error);
      void this.shutdown(error);
      return;
    }
    // Codex 0.144 accepts JSON-RPC 2.0 requests but omits the `jsonrpc`
    // member from its responses and notifications on the stdio wire.
    if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') {
      const error = new Error('Codex app-server emitted a malformed protocol message');
      this.failAll(error);
      void this.shutdown(error);
      return;
    }
    const hasMethod = typeof message.method === 'string';
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    const hasRequestId = typeof message.id === 'number' || typeof message.id === 'string';
    const serverRequest = hasMethod && hasRequestId && !hasResult && !hasError;
    const notification = hasMethod && !hasRequestId && !hasResult && !hasError;
    const response = !hasMethod && typeof message.id === 'number' && hasResult !== hasError;
    if ([serverRequest, notification, response].filter(Boolean).length !== 1) {
      const error = new Error('Codex app-server emitted a malformed protocol message');
      this.failAll(error);
      void this.shutdown(error);
      return;
    }
    if (
      typeof message.method === 'string' &&
      (typeof message.id === 'number' || typeof message.id === 'string')
    ) {
      this.handleServerRequest(child, message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === 'number') {
      const lateTurnStart = this.lateTurnStarts.get(message.id);
      if (lateTurnStart) {
        this.handleLateTurnStartResponse(message.id, lateTurnStart, message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        const error = new Error('Codex app-server response id did not match a pending request');
        this.failAll(error);
        void this.shutdown(error);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        const rpcError = object(message.error);
        const code = typeof rpcError?.code === 'number' ? rpcError.code : 0;
        pending.reject(
          new CodexAppServerRpcError(
            code,
            this.redact(errorMessage(message.error, `${pending.method} failed`))
          )
        );
      } else if (!Object.hasOwn(message, 'result')) {
        pending.reject(
          new Error(`Codex app-server ${pending.method} returned a malformed response`)
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const data = object(params);
    if (!data || typeof data.threadId !== 'string') {
      return;
    }
    const turn = this.turns.get(data.threadId);
    if (!turn) {
      return;
    }
    const completedTurn = method === 'turn/completed' ? object(data.turn) : undefined;
    const eventTurnId =
      typeof data.turnId === 'string'
        ? data.turnId
        : typeof completedTurn?.id === 'string'
          ? completedTurn.id
          : undefined;
    if (eventTurnId && !turn.turnId) {
      turn.queuedNotifications.push({ method, params });
      return;
    }
    if (eventTurnId && eventTurnId !== turn.turnId) {
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof data.turnId !== 'string' || data.turnId !== turn.turnId) {
        return;
      }
      if (typeof data.delta === 'string') {
        this.refreshTurnIdleTimeout(turn);
        turn.chunks.push(data.delta);
        try {
          turn.onDelta?.(data.delta);
        } catch (error: unknown) {
          this.failTurn(turn.threadId, this.toError(error));
        }
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      if (typeof data.turnId !== 'string' || data.turnId !== turn.turnId) {
        return;
      }
      const last = object(object(data.tokenUsage)?.last);
      this.refreshTurnIdleTimeout(turn);
      turn.usage = {
        input_tokens: typeof last?.inputTokens === 'number' ? last.inputTokens : 0,
        output_tokens: typeof last?.outputTokens === 'number' ? last.outputTokens : 0,
        cache_read_input_tokens:
          typeof last?.cachedInputTokens === 'number' ? last.cachedInputTokens : undefined,
      };
      return;
    }
    if (method !== 'turn/completed') {
      return;
    }
    const completed = completedTurn;
    if (
      !completed ||
      typeof completed.id !== 'string' ||
      (turn.turnId && completed.id !== turn.turnId)
    )
      return;
    const status = completed.status;
    if (status === 'inProgress') {
      return;
    }
    try {
      validateTurn(completed, 'turn/completed turn');
    } catch (error: unknown) {
      this.failTurn(turn.threadId, this.toError(error));
      return;
    }
    if (turn.abortError) {
      this.failTurn(turn.threadId, turn.abortError);
      return;
    }
    if (status === 'failed') {
      this.failTurn(
        turn.threadId,
        new Error(this.redact(errorMessage(completed.error, 'Codex app-server turn failed')))
      );
      return;
    }
    if (status === 'interrupted') {
      if (turn.abortError) {
        this.failTurn(turn.threadId, turn.abortError);
      } else if (turn.intentionalStop) {
        this.resolveTurn(turn);
      } else {
        this.failTurn(turn.threadId, new Error('Codex app-server turn was interrupted'));
      }
      return;
    }
    if (status !== 'completed') {
      this.failTurn(
        turn.threadId,
        new Error(`Codex app-server returned unknown turn status: ${String(status)}`)
      );
      return;
    }
    this.resolveTurn(turn);
  }

  private resolveTurn(turn: PendingTurn): void {
    if (this.turns.get(turn.threadId) !== turn) {
      return;
    }
    this.turns.delete(turn.threadId);
    clearTimeout(turn.timer);
    this.clearTurnCallbacks(turn);
    turn.resolve({
      response: turn.chunks.join(''),
      usage: turn.usage,
      session_id: turn.threadId,
      toolUseBlocks: undefined,
      hasToolUse: false,
    });
  }

  private handleServerRequest(
    child: ChildProcessWithoutNullStreams,
    id: number | string,
    method: string,
    params: unknown
  ): void {
    if (method === 'item/tool/call') {
      this.handleDynamicToolRequest({ child, id, params });
      return;
    }
    const bodies: Record<string, unknown> = {
      'item/tool/requestUserInput': { answers: {} },
      'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
      'item/commandExecution/requestApproval': { decision: 'decline' },
      'item/fileChange/requestApproval': { decision: 'decline' },
      'item/permissions/requestApproval': {
        permissions: {},
        scope: 'turn',
        strictAutoReview: true,
      },
      applyPatchApproval: { decision: 'denied' },
      execCommandApproval: { decision: 'denied' },
    };
    if (Object.hasOwn(bodies, method)) {
      this.reply(child, { jsonrpc: '2.0', id, result: bodies[method] });
    } else {
      this.reply(child, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unsupported app-server request: ${method}` },
      });
    }
  }

  private handleDynamicToolRequest(request: ServerToolRequest, expectedTurn?: PendingTurn): void {
    const data = object(request.params);
    const threadId = typeof data?.threadId === 'string' ? data.threadId : undefined;
    const turn = threadId ? this.turns.get(threadId) : undefined;
    if (!data || !turn || !turn.hostToolBridge || (expectedTurn && turn !== expectedTurn)) {
      this.replyDisabledTool(request);
      return;
    }
    try {
      const turnId = this.requiredToolString(data, 'turnId');
      const callId = this.requiredToolString(data, 'callId');
      const tool = this.requiredToolString(data, 'tool');
      if (data.namespace !== null && typeof data.namespace !== 'string') {
        throw new Error('Codex app-server tool call namespace must be null or a string');
      }
      const input = object(data.arguments);
      if (!input) {
        throw new Error('Codex app-server tool call arguments must be an object');
      }
      if (!turn.hostToolBridge.tools.some((definition) => definition.name === tool)) {
        throw new Error(`Codex app-server tool call ${tool} was not advertised`);
      }
      if (!turn.turnId) {
        turn.queuedToolRequests.push(request);
        return;
      }
      if (turnId !== turn.turnId) {
        this.failToolProtocol(
          request,
          turn,
          new Error('Codex app-server tool call did not match the active turn')
        );
        return;
      }
      this.refreshTurnIdleTimeout(turn);
      this.dispatchDynamicToolCall(request, turn, callId, tool, data.namespace, input);
    } catch (error: unknown) {
      this.failToolProtocol(request, turn, this.toError(error));
    }
  }

  private failToolProtocol(request: ServerToolRequest, turn: PendingTurn, error: Error): void {
    const failure = this.toError(error);
    this.replyToolError(request, failure.message);
    this.failTurn(turn.threadId, failure);
    if (this.child === request.child && !this.shutdownPromise) {
      void this.shutdown(failure);
    }
  }

  private requiredToolString(data: JsonObject, field: string): string {
    const value = data[field];
    if (typeof value !== 'string' || !value) {
      throw new Error(`Codex app-server tool call ${field} must be a string`);
    }
    return value;
  }

  private dispatchDynamicToolCall(
    request: ServerToolRequest,
    turn: PendingTurn,
    callId: string,
    tool: string,
    namespace: string | null,
    input: JsonObject
  ): void {
    const identity = JSON.stringify(
      stableJson({
        threadId: turn.threadId,
        turnId: turn.turnId,
        tool,
        namespace,
        arguments: input,
      })
    );
    const existing = turn.toolCallResults.get(callId);
    if (existing && existing.identity !== identity) {
      throw new Error(`Codex app-server callId ${callId} had a conflicting request`);
    }
    let execution = existing?.execution;
    if (!execution) {
      const bridge = turn.hostToolBridge;
      if (!bridge) {
        this.replyDisabledTool(request);
        return;
      }
      execution = turn.toolCallQueue
        .then(async () => {
          if (!this.isToolTurnActive(request, turn)) {
            return {
              result: this.toolResult(false, 'Codex app-server tool call is no longer active'),
              stop: false,
              abortError: undefined,
            };
          }
          let result: unknown;
          try {
            result = await bridge.execute({
              callId,
              name: tool,
              input,
              signal: turn.abortController.signal,
            });
          } catch (error: unknown) {
            result = { content: this.toError(error).message, isError: true };
          }
          const resultData = object(result);
          if (
            !resultData ||
            typeof resultData.content !== 'string' ||
            typeof resultData.isError !== 'boolean'
          ) {
            return {
              result: this.toolResult(false, 'Host tool returned a malformed result'),
              stop: false,
              abortError: undefined,
            };
          }
          const abortError =
            resultData.abort === true && resultData.isError
              ? isHostToolTerminalCode(resultData.terminalCode)
                ? new HostToolTerminalError(resultData.terminalCode, resultData.content)
                : new Error(resultData.content)
              : undefined;
          if (abortError instanceof HostToolTerminalError) {
            turn.settledTerminalError ??= abortError;
          }
          return {
            result: this.toolResult(!resultData.isError, resultData.content),
            stop: resultData.stop === true && !resultData.isError,
            abortError,
          };
        })
        .catch((error: unknown) => ({
          result: this.toolResult(false, this.toError(error).message),
          stop: false,
          abortError: undefined,
        }));
      turn.toolCallResults.set(callId, { identity, execution });
      turn.toolCallQueue = execution.then(
        () => undefined,
        () => undefined
      );
    }
    void execution.then(({ result, stop, abortError }) => {
      if (!this.isToolTurnActive(request, turn)) {
        if (this.child === request.child) {
          this.replyToolError(request, 'Codex app-server tool call is no longer active');
        }
        return;
      }
      this.refreshTurnIdleTimeout(turn);
      this.reply(request.child, { jsonrpc: '2.0', id: request.id, result });
      if (abortError && !turn.stoppingCallIds.has(callId)) {
        turn.stoppingCallIds.add(callId);
        turn.abortError = abortError;
        void this.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId }).catch(
          (error: unknown) => this.failTurn(turn.threadId, this.toError(error))
        );
      } else if (stop && !turn.stoppingCallIds.has(callId)) {
        turn.stoppingCallIds.add(callId);
        turn.intentionalStop = true;
        void this.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId }).catch(
          (error: unknown) => this.failTurn(turn.threadId, this.toError(error))
        );
      }
    });
  }

  private isToolTurnActive(request: ServerToolRequest, turn: PendingTurn): boolean {
    return (
      this.child === request.child &&
      this.turns.get(turn.threadId) === turn &&
      !turn.intentionalStop &&
      !turn.abortError &&
      !turn.abortController.signal.aborted
    );
  }

  private toolResult(success: boolean, content: string): JsonObject {
    return { success, contentItems: [{ type: 'inputText', text: content }] };
  }

  private replyDisabledTool(request: ServerToolRequest): void {
    this.reply(request.child, {
      jsonrpc: '2.0',
      id: request.id,
      result: this.toolResult(false, 'Native app-server tools are disabled by MAMA'),
    });
  }

  private replyToolError(request: ServerToolRequest, message: string): void {
    this.reply(request.child, {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message },
    });
  }

  private reply(child: ChildProcessWithoutNullStreams, message: JsonObject): void {
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private handleStderr(line: string): void {
    this.stderrTail = `${this.stderrTail}${this.redact(line)}\n`.slice(-STDERR_LIMIT);
  }

  private redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join('[REDACTED]');
    }
    return result;
  }

  private toError(error: unknown): Error {
    if (error instanceof HostToolTerminalError) {
      return new HostToolTerminalError(error.terminalCode, this.redact(error.message));
    }
    return error instanceof Error
      ? new Error(this.redact(error.message))
      : new Error(this.redact(String(error)));
  }

  private refreshTurnIdleTimeout(turn: PendingTurn): void {
    if (this.turns.get(turn.threadId) !== turn) {
      return;
    }
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      const error = new Error(
        `Codex app-server turn timed out after ${turn.requestTimeout}ms without progress`
      );
      this.timeoutTurn(turn.threadId, error, turn.requestTimeout);
    }, turn.requestTimeout);
    turn.timer.unref();
  }

  private failTurn(threadId: string, error: Error): void {
    const turn = this.turns.get(threadId);
    if (!turn) {
      return;
    }
    this.turns.delete(threadId);
    clearTimeout(turn.timer);
    turn.abortController.abort(error);
    turn.queuedNotifications.length = 0;
    turn.queuedToolRequests.length = 0;
    const safe = this.toError(error);
    // A gateway mutation that cannot be interrupted must settle before the
    // caller sees failure. This prevents retries from racing a late mutation.
    void turn.toolCallQueue.finally(() => {
      this.clearTurnCallbacks(turn);
      const terminalError =
        turn.settledTerminalError ??
        (turn.abortError instanceof HostToolTerminalError ? turn.abortError : undefined);
      turn.reject(this.toError(terminalError ?? safe));
    });
  }

  private timeoutTurn(threadId: string, error: Error, requestTimeout: number): void {
    const turn = this.turns.get(threadId);
    if (!turn) {
      return;
    }
    const turnId = turn.turnId;
    if (!turnId) {
      this.getOrCreateTurnStartReconciliation(threadId);
    }
    this.failTurn(threadId, error);
    if (!turnId) {
      return;
    }
    void this.request('turn/interrupt', { threadId, turnId }, requestTimeout).catch(
      (interruptError: unknown) => {
        if (this.child && !this.shutdownPromise) {
          void this.shutdown(this.toError(interruptError));
        }
      }
    );
  }

  private getOrCreateTurnStartReconciliation(threadId: string): TurnStartReconciliation {
    const existing = this.turnStartReconciliations.get(threadId);
    if (existing) {
      return existing;
    }
    let resolveReconciliation: (() => void) | undefined;
    const promise = new Promise<void>((resolvePromise) => {
      resolveReconciliation = resolvePromise;
    });
    const reconciliation: TurnStartReconciliation = {
      promise,
      resolve: () => resolveReconciliation?.(),
    };
    this.turnStartReconciliations.set(threadId, reconciliation);
    return reconciliation;
  }

  private completeTurnStartReconciliation(
    threadId: string,
    reconciliation: TurnStartReconciliation
  ): void {
    if (this.turnStartReconciliations.get(threadId) !== reconciliation) {
      return;
    }
    if (reconciliation.recoveryTimer) {
      clearTimeout(reconciliation.recoveryTimer);
      reconciliation.recoveryTimer = undefined;
    }
    this.turnStartReconciliations.delete(threadId);
    reconciliation.resolve();
  }

  private async reconcileAcknowledgedTurn(
    threadId: string,
    turnId: string,
    requestTimeout: number
  ): Promise<void> {
    const reconciliation = this.turnStartReconciliations.get(threadId);
    if (!reconciliation) {
      return;
    }
    try {
      await this.request('turn/interrupt', { threadId, turnId }, requestTimeout);
      this.completeTurnStartReconciliation(threadId, reconciliation);
    } catch (error: unknown) {
      await this.shutdown(this.toError(error));
      this.completeTurnStartReconciliation(threadId, reconciliation);
    }
  }

  private handleLateTurnStartResponse(
    id: number,
    late: LateTurnStart,
    message: JsonRpcMessage
  ): void {
    this.lateTurnStarts.delete(id);
    if (late.reconciliation.recoveryTimer) {
      clearTimeout(late.reconciliation.recoveryTimer);
      late.reconciliation.recoveryTimer = undefined;
    }
    if (message.error !== undefined) {
      this.completeTurnStartReconciliation(late.threadId, late.reconciliation);
      return;
    }
    try {
      const turn = validateTurn(object(message.result)?.turn, 'late turn/start turn');
      if (typeof turn?.id !== 'string' || !turn.id) {
        throw new Error('Codex app-server late turn/start returned no turn id');
      }
      void this.reconcileAcknowledgedTurn(late.threadId, turn.id, late.requestTimeout);
    } catch (error: unknown) {
      void this.shutdown(this.toError(error)).finally(() => {
        this.completeTurnStartReconciliation(late.threadId, late.reconciliation);
      });
    }
  }

  private clearTurnCallbacks(turn: PendingTurn): void {
    turn.queuedNotifications.length = 0;
    turn.queuedToolRequests.length = 0;
    turn.toolCallResults.clear();
    turn.stoppingCallIds.clear();
    turn.hostToolBridge = undefined;
    turn.onDelta = undefined;
  }

  private failAll(error: Error): void {
    const safe = this.toError(error);
    for (const threadId of [...this.turns.keys()]) {
      this.failTurn(threadId, safe);
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(safe);
    }
  }

  private failProcess(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) {
      return;
    }
    const suffix = this.stderrTail ? `: ${this.stderrTail}` : '';
    this.failAll(new Error(this.redact(`${error.message}${suffix}`)));
    this.detach(child);
  }

  private async restart(): Promise<void> {
    await this.shutdown(new Error('Codex app-server restarting after auth refresh'));
    this.sessions.clear();
  }

  private async shutdown(reason: Error): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    const operation = this.performShutdown(reason);
    this.shutdownPromise = operation;
    try {
      await operation;
    } finally {
      if (this.shutdownPromise === operation) {
        this.shutdownPromise = undefined;
      }
    }
  }

  private async performShutdown(reason: Error): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.failAll(reason);
    await new Promise<void>((resolveStop) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.killTimer) {
          clearTimeout(this.killTimer);
          this.killTimer = undefined;
        }
        if (this.finalKillTimer) {
          clearTimeout(this.finalKillTimer);
          this.finalKillTimer = undefined;
        }
        this.detach(child);
        resolveStop();
      };
      child.once('exit', finish);
      child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        this.killTimer = undefined;
        this.finalKillTimer = setTimeout(finish, STOP_GRACE_MS);
        this.finalKillTimer.unref();
      }, STOP_GRACE_MS);
      this.killTimer.unref();
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
      }
    });
  }

  private detach(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) {
      return;
    }
    this.stdout?.close();
    this.stderr?.close();
    child.removeAllListeners();
    child.stdin.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    this.stdout = undefined;
    this.stderr = undefined;
    this.child = undefined;
    this.sessions.clear();
    this.lateTurnStarts.clear();
    for (const [threadId, reconciliation] of this.turnStartReconciliations) {
      this.completeTurnStartReconciliation(threadId, reconciliation);
    }
  }
}
