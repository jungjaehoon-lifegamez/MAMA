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
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import type { PromptResult } from './model-runner.js';
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
  queuedNotifications: Array<{ method: string; params: unknown }>;
  onDelta?: (text: string) => void;
  resolve: (result: PromptResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT = 300_000;
const STOP_GRACE_MS = 200;
const STDERR_LIMIT = 4_000;
const CLIENT_INFO = { name: 'mama-codex-app-server', version: '1.0.0' };
const TURN_STATUSES = new Set(['completed', 'interrupted', 'failed', 'inProgress']);
const TURN_ITEM_VIEWS = new Set(['notLoaded', 'summary', 'full']);
const APPROVAL_REVIEWERS = new Set(['user', 'auto_review', 'guardian_subagent']);

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
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
  > & { mcpConfigPath?: string };
  private readonly registry: CodexThreadRegistry;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: ReadlineInterface | undefined;
  private stderr: ReadlineInterface | undefined;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private turn: PendingTurn | undefined;
  private threadId = '';
  private startPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private stopped = false;
  private busy = false;
  private stderrTail = '';
  private secrets = new Set<string>();
  private authFingerprint: string | undefined;
  private authFingerprintInitialized = false;
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

  async prompt(text: string, callbacks?: PromptCallbacks): Promise<PromptResult> {
    if (this.stopped) {
      throw new Error('Codex app-server process is stopped');
    }
    if (this.busy) {
      throw new Error('Codex app-server process is busy');
    }
    this.busy = true;
    try {
      const launch = buildCodexAppServerLaunchConfig(this.options.mcpConfigPath, process.env);
      this.assertRegistryPolicy(launch);
      const refreshed = this.prepareManagedFiles(launch);
      if (refreshed && this.child) {
        await this.restart();
      }
      await this.ensureStarted(launch);
      if (!this.threadId) {
        await this.openThread(launch);
      }
      return await this.startTurn(text, callbacks);
    } catch (error: unknown) {
      if (this.shutdownPromise) {
        await this.shutdownPromise;
      } else if (this.child) {
        await this.shutdown(this.toError(error));
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async reset(): Promise<void> {
    this.registry.remove(this.options.sessionKey);
    this.threadId = '';
    if (this.child) {
      await this.restart();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.shutdown(new Error('Codex app-server process stopped'));
  }

  getThreadId(): string | undefined {
    return this.threadId || undefined;
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
      hasActiveTurn: this.turn !== undefined,
      stdoutListenerCount: this.stdout?.listenerCount('line') ?? 0,
      stderrListenerCount: this.stderr?.listenerCount('line') ?? 0,
      shutdownTimerActive: this.killTimer !== undefined || this.finalKillTimer !== undefined,
    };
  }

  private assertRegistryPolicy(launch: CodexAppServerLaunchConfig): void {
    const record = this.registry.load(this.options.sessionKey);
    if (!record) {
      return;
    }
    const matches =
      record.model === this.options.model &&
      record.cwd === this.options.cwd &&
      record.mcpConfigFingerprint === launch.fingerprint;
    if (!matches) {
      throw new Error('Codex app-server thread policy mismatch; reset the session explicitly');
    }
  }

  private prepareManagedFiles(launch: CodexAppServerLaunchConfig): boolean {
    ensurePrivateDirectory(this.options.codexHome);
    ensurePrivateDirectory(this.options.isolatedHome);
    atomicPrivateWrite(
      join(this.options.codexHome, 'config.toml'),
      buildMAMACodexAppServerConfig()
    );
    const sourceAuth = join(homedir(), '.codex', 'auth.json');
    const sourceFingerprint =
      existsSync(sourceAuth) && statSync(sourceAuth).size > 0 ? shaFile(sourceAuth) : undefined;
    if (sourceFingerprint) {
      copyAuthAtomically(sourceAuth, join(this.options.codexHome, 'auth.json'));
    }
    const changed = this.authFingerprintInitialized && this.authFingerprint !== sourceFingerprint;
    this.authFingerprint = sourceFingerprint;
    this.authFingerprintInitialized = true;
    this.secrets = configuredSecretValues(launch);
    return changed;
  }

  private async ensureStarted(launch: CodexAppServerLaunchConfig): Promise<void> {
    if (this.child) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.start(launch);
    }
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async start(launch: CodexAppServerLaunchConfig): Promise<void> {
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
    const initialized = await this.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    });
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

  private async openThread(launch: CodexAppServerLaunchConfig): Promise<void> {
    const record = this.registry.load(this.options.sessionKey);
    if (record) {
      const result = object(
        await this.request('thread/resume', {
          threadId: record.threadId,
          model: this.options.model,
          cwd: this.options.cwd,
          approvalPolicy: 'never',
          sandbox: this.options.sandbox,
        })
      );
      this.validateResponsePolicy(result);
      this.validateInstructionMetadata(result);
      const resumed = validateThread(result?.thread);
      if (typeof resumed?.id !== 'string' || resumed.id !== record.threadId) {
        throw new Error('Codex app-server resumed an unexpected thread');
      }
      this.threadId = record.threadId;
      return;
    }
    const result = object(
      await this.request('thread/start', {
        model: this.options.model,
        cwd: this.options.cwd,
        approvalPolicy: 'never',
        sandbox: this.options.sandbox,
        baseInstructions: this.options.systemPrompt,
        config: {},
      })
    );
    this.validateResponsePolicy(result);
    this.validateInstructionMetadata(result);
    const thread = validateThread(result?.thread);
    if (typeof thread?.id !== 'string' || !thread.id) {
      throw new Error('Codex app-server thread/start returned no thread id');
    }
    this.threadId = thread.id;
    this.registry.save({
      sessionKey: this.options.sessionKey,
      threadId: thread.id,
      model: this.options.model,
      cwd: this.options.cwd,
      systemPromptFingerprint: fingerprintText(this.options.systemPrompt),
      mcpConfigFingerprint: launch.fingerprint,
    });
  }

  private validateInstructionMetadata(result: JsonObject | undefined): void {
    const sources = result?.instructionSources;
    if (!Array.isArray(sources)) {
      throw new Error('Codex app-server returned malformed instruction sources');
    }
    for (const source of sources) {
      if (typeof source !== 'string') {
        throw new Error('Codex app-server returned malformed instruction source');
      }
      const path = resolve(source);
      const allowed = [this.options.cwd, this.options.codexHome].some(
        (root) => path === root || path.startsWith(`${root}/`)
      );
      if (!allowed) {
        throw new Error('Codex app-server loaded an instruction source outside managed roots');
      }
    }
  }

  private validateResponsePolicy(result: JsonObject | undefined): void {
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
    if (typeof result.model !== 'string' || result.model !== this.options.model) {
      throw new Error('Codex app-server response model did not match the requested policy');
    }
    if (typeof result.cwd !== 'string' || resolve(result.cwd) !== this.options.cwd) {
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
    }[this.options.sandbox];
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

  private startTurn(text: string, callbacks?: PromptCallbacks): Promise<PromptResult> {
    return new Promise<PromptResult>((resolveTurn, rejectTurn) => {
      const timer = setTimeout(() => {
        const error = new Error(
          `Codex app-server turn timed out after ${this.options.requestTimeout}ms`
        );
        this.failTurn(error);
        void this.shutdown(error);
      }, this.options.requestTimeout);
      timer.unref();
      this.turn = {
        threadId: this.threadId,
        chunks: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        timer,
        queuedNotifications: [],
        onDelta: callbacks?.onDelta,
        resolve: resolveTurn,
        reject: rejectTurn,
      };
      this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      })
        .then((value) => {
          const turn = validateTurn(object(value)?.turn, 'turn/start turn');
          if (typeof turn?.id !== 'string' || !turn.id) {
            this.failTurn(new Error('Codex app-server turn/start returned no turn id'));
            return;
          }
          if (this.turn) {
            this.turn.turnId = turn.id;
            const queued = this.turn.queuedNotifications.splice(0);
            for (const notification of queued) {
              this.handleNotification(notification.method, notification.params);
            }
          }
        })
        .catch((error: unknown) => this.failTurn(this.toError(error)));
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server stdin is not writable'));
    }
    const id = ++this.nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `Codex app-server ${method} timed out after ${this.options.requestTimeout}ms`
        );
        rejectRequest(error);
        void this.shutdown(error);
      }, this.options.requestTimeout);
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
      this.handleServerRequest(message.id, message.method);
      return;
    }
    if (typeof message.id === 'number') {
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
        pending.reject(
          new Error(this.redact(errorMessage(message.error, `${pending.method} failed`)))
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
    const turn = this.turn;
    if (!turn || data?.threadId !== turn.threadId) {
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
        turn.chunks.push(data.delta);
        try {
          turn.onDelta?.(data.delta);
        } catch (error: unknown) {
          this.failTurn(this.toError(error));
        }
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      if (typeof data.turnId !== 'string' || data.turnId !== turn.turnId) {
        return;
      }
      const last = object(object(data.tokenUsage)?.last);
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
      this.failTurn(this.toError(error));
      return;
    }
    if (status === 'failed') {
      this.failTurn(
        new Error(this.redact(errorMessage(completed.error, 'Codex app-server turn failed')))
      );
      return;
    }
    if (status === 'interrupted') {
      this.failTurn(new Error('Codex app-server turn was interrupted'));
      return;
    }
    if (status !== 'completed') {
      this.failTurn(new Error(`Codex app-server returned unknown turn status: ${String(status)}`));
      return;
    }
    this.turn = undefined;
    clearTimeout(turn.timer);
    turn.resolve({
      response: turn.chunks.join(''),
      usage: turn.usage,
      session_id: turn.threadId,
      toolUseBlocks: undefined,
      hasToolUse: false,
    });
  }

  private handleServerRequest(id: number | string, method: string): void {
    const bodies: Record<string, unknown> = {
      'item/tool/requestUserInput': { answers: {} },
      'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
      'item/tool/call': {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Native app-server tools are disabled by MAMA' }],
      },
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
      this.reply({ jsonrpc: '2.0', id, result: bodies[method] });
    } else {
      this.reply({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unsupported app-server request: ${method}` },
      });
    }
  }

  private reply(message: JsonObject): void {
    if (this.child?.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
    return error instanceof Error
      ? new Error(this.redact(error.message))
      : new Error(this.redact(String(error)));
  }

  private failTurn(error: Error): void {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    this.turn = undefined;
    clearTimeout(turn.timer);
    turn.reject(this.toError(error));
  }

  private failAll(error: Error): void {
    const safe = this.toError(error);
    this.failTurn(safe);
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
    this.stopped = false;
    this.threadId = '';
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
    this.threadId = '';
  }
}
