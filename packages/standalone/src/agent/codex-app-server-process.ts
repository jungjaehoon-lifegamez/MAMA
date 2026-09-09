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
  /** Managed `model_reasoning_effort`; unset means the built-in default, unknown values throw. */
  effort?: string;
  /** Stable identity/rules fingerprint; dynamic conversation context must be excluded. */
  policyFingerprint?: string;
  /** Observability sink for Codex-native subagent threads spawned by a parent turn. */
  onSubagentEvent?: (event: SubagentEvent) => void;
  /**
   * Host factory for a CHILD-SCOPED authority. A child outlives the parent turn, so it
   * must never inherit the parent's snapshot bridge (whose envelope expires with the
   * parent wall). Called once per announced child; the child's tool calls are queued
   * until it resolves. `null` (or no factory at all) means the child has no authority
   * and every call it makes is refused with `subagent authority unavailable`.
   */
  createSubagentBridge?: (info: SubagentBridgeRequest) => Promise<SubagentBridge | null>;
  /**
   * Grace after the PARENT announced a child completed before the child's missing own
   * `turn/completed` is reported as `unknown`. Test seam; the default is 5s.
   */
  subagentGraceMs?: number;
  /** Bounded life of a registered child; a child Codex killed must not leak. */
  subagentTtlMs?: number;
}

/** What the host is asked for when Codex announces a child thread. */
export interface SubagentBridgeRequest {
  /** The PARENT's session key; a child never owns a session of its own. */
  sessionKey: string;
  parentThreadId: string;
  agentThreadId: string;
  agentPath: string;
}

/**
 * One child's own authority: its tools and the release that closes its run.
 *
 * `release` is called exactly once per child, with the terminal status the process
 * observed. `unknown` means the parent announced a completion the child's own
 * `turn/completed` never confirmed - it is not success.
 */
export interface SubagentBridge {
  bridge: HostToolBridge;
  release: (outcome: {
    status: 'completed' | 'failed' | 'interrupted' | 'unknown';
    error?: string;
  }) => Promise<void>;
}

/**
 * One Codex-native subagent thread, observed from the parent thread.
 *
 * Codex announces children on the PARENT thread as `subAgentActivity` items and then
 * drives the child on ITS OWN thread id - including after the parent turn completed.
 * These events only report that; they never gate the child.
 */
export interface SubagentEvent {
  kind: 'started' | 'completed';
  /** The PARENT's session key; a child never owns a session of its own. */
  sessionKey: string;
  parentThreadId: string;
  agentThreadId: string;
  /** Codex agent path, e.g. "/root/board". */
  agentPath: string;
  /**
   * Completion events only. `unknown` is the honest verdict when the parent announced a
   * completion and the child's own `turn/completed` never arrived: no result, no failure
   * either. It must never be rendered as success.
   */
  status?: 'completed' | 'failed' | 'interrupted' | 'unknown';
  /** Last `final_answer` agentMessage text seen on the child thread, bounded. */
  finalText?: string;
  /** Redacted failure message; failed child turns only. */
  error?: string;
}

export interface CodexAppServerPromptOptions {
  /**
   * Per-run counted-token budget (input + output; codex reports input INCLUSIVE of cache,
   * so cache reads are not added again). A codex turn is a whole
   * agentic loop of model calls, so the budget is checked on every usage event INSIDE the
   * turn and the turn is interrupted when it crosses; AgentLoop's per-turn check would only
   * see the total after the turn ended (0.43.0 stopped board runs one turn too late).
   */
  runTokenBudget?: number;
  sessionKey?: string;
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  requestTimeout?: number;
  policyFingerprint?: string;
  resumeSession?: boolean;
  hostToolBridge?: HostToolBridge;
  /**
   * Full instructions to re-supply when this call has to resume a durable thread.
   * `thread/resume` accepts `baseInstructions` (ThreadResumeParams), so a rehydrated
   * thread can be re-anchored through the protocol instead of the turn-text
   * `<system-reminder>` workaround. Lazy on purpose: rebuilding the composed prompt
   * costs an embedding search, and a live thread never resumes - the callback runs
   * only inside the resume branch. Omit it to keep the legacy bootstrap behaviour.
   */
  resumeInstructions?: () => Promise<string>;
  /** Measurement only: host lane and brief state for the per-turn [prompt] log line. */
  promptTelemetry?: { kind: string; brief: 'sent' | 'omitted' };
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
  usageBaseline?: { input: number; output: number; cached: number };
  usageShrinkWarned?: boolean;
  /** Counted-token budget for this run; 0/undefined disables the in-turn check. */
  runTokenBudget?: number;
  budgetStopped?: boolean;
  abortError?: Error;
  settledTerminalError?: HostToolTerminalError;
  onDelta?: (text: string) => void;
  onToolUse?: PromptCallbacks['onToolUse'];
  onToolComplete?: PromptCallbacks['onToolComplete'];
  onSubagentStart?: PromptCallbacks['onSubagentStart'];
  nativeItems: Map<string, { name: string; completed: boolean }>;
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
  resumeInstructions?: () => Promise<string>;
  promptTelemetry?: { kind: string; brief: 'sent' | 'omitted' };
}

interface SessionState {
  threadId: string;
  bootstrapPending: boolean;
}

/**
 * Which session a thread belongs to, and where its observability callbacks go. A child
 * can be announced after the parent turn already resolved (PendingTurn is gone by then),
 * so this outlives the turn. It deliberately carries NO host tool bridge: authority is
 * never inherited across the parent turn boundary (see `createSubagentBridge`).
 */
interface ThreadContext {
  sessionKey: string;
  onToolUse?: PromptCallbacks['onToolUse'];
  onToolComplete?: PromptCallbacks['onToolComplete'];
}

interface SubagentState extends ThreadContext {
  parentThreadId: string;
  agentPath: string;
  finalText: string;
  startedAt: number;
  /** Per-child serialization; mirrors PendingTurn's queue so duplicate callIds settle once. */
  toolCallQueue: Promise<void>;
  toolCallResults: Map<string, HostToolCallState>;
  stoppingCallIds: Set<string>;
  abortController: AbortController;
  /** This child's OWN authority, requested once at registration. */
  authority: Promise<SubagentBridge | null>;
  /** One log line per child when it has no authority, not one per refused call. */
  authorityWarned: boolean;
  /** Bounded life: a child Codex killed silently must still resolve. */
  ttlTimer?: NodeJS.Timeout;
  /** Started by the PARENT's completion announcement; the child's own turn wins. */
  graceTimer?: NodeJS.Timeout;
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
const SUBAGENT_FINAL_TEXT_LIMIT = 4_000;
/** Wait for the child's own `turn/completed` after the parent announced it finished. */
const SUBAGENT_COMPLETION_GRACE_MS = 5_000;
/** A registered child that never completes is reported failed rather than leaked. */
const SUBAGENT_TTL_MS = 45 * 60_000;
/** Bound on remembered finished child threads; identity, not history. */
const MAX_FINISHED_SUBAGENTS = 200;
const SUBAGENT_AUTHORITY_UNAVAILABLE = 'subagent authority unavailable';
const SUBAGENT_AUTHORITY_EXPIRED = 'subagent authority expired';
/** EnvelopeViolation code prefix the enforcer returns once a grant is past its wall. */
const ENVELOPE_EXPIRED_MARKER = '[expired]';

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
  > & {
    mcpConfigPath?: string;
    policyFingerprint?: string;
    effort?: string;
    onSubagentEvent?: (event: SubagentEvent) => void;
    createSubagentBridge?: (info: SubagentBridgeRequest) => Promise<SubagentBridge | null>;
    subagentGraceMs?: number;
    subagentTtlMs?: number;
  };
  private readonly registry: CodexThreadRegistry;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: ReadlineInterface | undefined;
  private stderr: ReadlineInterface | undefined;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private lateTurnStarts = new Map<number, LateTurnStart>();
  private turnStartReconciliations = new Map<string, TurnStartReconciliation>();
  private turns = new Map<string, PendingTurn>();
  private readonly subagents = new Map<string, SubagentState>();
  /**
   * Child threads that already reported a terminal status. The SAME `started`
   * announcement arrives as both an item/started and an item/completed view, and the
   * second view can land after the child's own turn/completed - `subagents.has` no longer
   * dedupes it then, so it would mint a second authority and a second completion for a
   * dead child. Bounded FIFO: identity of recent children, not a growing ledger.
   */
  private readonly finishedSubagents = new Set<string>();
  private readonly threadContexts = new Map<string, ThreadContext>();
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
          this.discardSessionThreadState(session.sessionKey, 'session was restarted');
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
        const replayReminder = Boolean(state.bootstrapPending && session.systemPrompt);
        const turnText = replayReminder
          ? `<system-reminder>\nFresh MAMA runtime context after resuming this durable thread:\n${session.systemPrompt.replace(/<\/system-reminder>/gi, '')}\n</system-reminder>\n\n${text}`
          : text;
        // One line per turn, where the text that actually reaches the model is known.
        // This is what makes "fixed things once, turns carry only deltas" measurable
        // from daemon.log instead of asserted.
        console.log(
          `[prompt] thread=${state.threadId} kind=${session.promptTelemetry?.kind ?? 'chat'} ` +
            `chars=${turnText.length} brief=${session.promptTelemetry?.brief ?? 'omitted'} ` +
            `reminder=${replayReminder ? 'sent' : 'omitted'}`
        );
        // A Codex-native child can be announced after this turn resolved, so remember
        // which session the thread belongs to outside the PendingTurn lifetime. The
        // parent's BRIDGE is deliberately not kept: a child gets its own authority.
        // A session that rotated its thread leaves the previous thread's context behind,
        // and a stale entry both leaks and lets a dead thread announce children.
        this.pruneThreadContexts(session.sessionKey, state.threadId);
        this.threadContexts.set(state.threadId, {
          sessionKey: session.sessionKey,
          onToolUse: callbacks?.onToolUse,
          onToolComplete: callbacks?.onToolComplete,
        });
        const result = await this.startTurn(
          state.threadId,
          turnText,
          callbacks,
          session.requestTimeout,
          session.hostToolBridge,
          overrides.runTokenBudget
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
      this.discardSessionThreadState(sessionKey, 'session was reset');
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
    this.terminateSubagents(new Error('Codex app-server process stopped'));
    this.threadContexts.clear();
  }

  async executeSandboxedCommand(
    command: string,
    cwd: string,
    roots: readonly string[],
    signal?: AbortSignal
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    signal?.throwIfAborted();
    if (!this.child) throw new Error('Codex app-server is not connected');
    const shellCommand =
      process.platform === 'win32'
        ? ['cmd.exe', '/d', '/s', '/c', command]
        : ['/bin/sh', '-c', command];
    const result = object(
      await this.request(
        'command/exec',
        {
          command: shellCommand,
          cwd,
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [...roots],
            readOnlyAccess: {
              type: 'restricted',
              includePlatformDefaults: true,
              readableRoots: [...roots],
            },
            networkAccess: false,
          },
          timeoutMs: this.options.requestTimeout,
        },
        this.options.requestTimeout
      )
    );
    signal?.throwIfAborted();
    if (
      typeof result?.exitCode !== 'number' ||
      typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string'
    ) {
      throw new Error('Codex app-server returned a malformed command result');
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
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
      resumeInstructions: overrides.resumeInstructions,
      promptTelemetry: overrides.promptTelemetry,
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
    const config = buildMAMACodexAppServerConfig(this.options.effort);
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
      // A rehydrated thread carries its original instructions only in the model's own
      // history, where compaction eventually erodes them. ThreadResumeParams accepts
      // baseInstructions, so re-anchor through the protocol when the caller can supply
      // the full text. assertRegistryPolicy already proved the stored policy fingerprint
      // matches this session, and the caller builds these instructions from the same
      // composed-prompt sources that produced that fingerprint - so re-supplying them
      // restates the agreed policy rather than switching to a new one.
      const resumeInstructions = session.resumeInstructions
        ? await session.resumeInstructions()
        : undefined;
      if (session.resumeInstructions && !resumeInstructions?.trim()) {
        // No-fallback: silently resuming without instructions is the very failure this
        // path exists to remove.
        throw new Error('Codex app-server resume instructions resolved to empty text');
      }
      const resumeParams: JsonObject = {
        threadId: record.threadId,
        model: session.model,
        cwd: session.cwd,
        approvalPolicy: 'never',
        sandbox: session.sandbox,
      };
      if (resumeInstructions) {
        resumeParams.baseInstructions = resumeInstructions;
      }
      const result = object(
        await this.request('thread/resume', resumeParams, session.requestTimeout)
      );
      this.validateResponsePolicy(result, session);
      this.validateInstructionMetadata(result, session);
      const resumed = validateThread(result?.thread);
      if (typeof resumed?.id !== 'string' || resumed.id !== record.threadId) {
        throw new Error('Codex app-server resumed an unexpected thread');
      }
      // Instructions delivered through the protocol make the turn-text bootstrap
      // redundant; without them the legacy <system-reminder> replay still applies.
      return { threadId: record.threadId, bootstrapPending: resumeInstructions === undefined };
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
    hostToolBridge: HostToolBridge | undefined,
    runTokenBudget?: number
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
        runTokenBudget,
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
        onToolUse: callbacks?.onToolUse,
        onToolComplete: callbacks?.onToolComplete,
        onSubagentStart: callbacks?.onSubagentStart,
        nativeItems: new Map(),
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
    if (this.handleSubagentNotification(method, data.threadId, data)) {
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
    // TG-03/04/05/06: these notifications observe native effects; they are not
    // pre-execution hooks. Dynamic/MCP calls retain their existing host bridge.
    if (method === 'item/started' || method === 'item/completed') {
      if (typeof data.turnId !== 'string' || data.turnId !== turn.turnId) {
        return;
      }
      const item = object(data.item);
      if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') {
        return;
      }
      if (!['commandExecution', 'fileChange', 'collabAgentToolCall'].includes(item.type)) {
        return;
      }
      this.refreshTurnIdleTimeout(turn);
      try {
        let observed = turn.nativeItems.get(item.id);
        if (!observed) {
          observed = { name: item.type, completed: false };
          turn.nativeItems.set(item.id, observed);
          // Persist bounded identity only: command bodies and file diffs can contain secrets.
          turn.onToolUse?.(item.type, { nativeToolUseId: item.id });
        }
        if (method === 'item/completed' && !observed.completed) {
          observed.completed = true;
          const isError =
            item.status !== 'completed' ||
            (typeof item.exitCode === 'number' && item.exitCode !== 0);
          turn.onToolComplete?.(observed.name, item.id, isError);
        }
      } catch (error: unknown) {
        this.failTurn(turn.threadId, this.toError(error));
      }
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
      const tokenUsage = object(data.tokenUsage);
      const last = object(tokenUsage?.last);
      const total = object(tokenUsage?.total);
      this.refreshTurnIdleTimeout(turn);
      const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
      if (total) {
        // Turn usage = cumulative-thread delta. The baseline derives from the
        // first total-bearing event (total minus its own call, minus any usage
        // already accumulated from total-less events this turn), so a resumed
        // thread's unseen history is never attributed to this turn, and a
        // multi-call tool-loop turn keeps its earlier calls (recording only
        // `last` undercounted ~5x against the rollout ground truth).
        turn.usageBaseline ??= {
          input: num(total.inputTokens) - num(last?.inputTokens) - turn.usage.input_tokens,
          output: num(total.outputTokens) - num(last?.outputTokens) - turn.usage.output_tokens,
          cached:
            num(total.cachedInputTokens) -
            num(last?.cachedInputTokens) -
            (turn.usage.cache_read_input_tokens ?? 0),
        };
        // A total below the baseline (compaction/rollback resetting the thread
        // counter) must never write negative usage into the metrics DB.
        const input = num(total.inputTokens) - turn.usageBaseline.input;
        const output = num(total.outputTokens) - turn.usageBaseline.output;
        const cached = num(total.cachedInputTokens) - turn.usageBaseline.cached;
        if ((input < 0 || output < 0 || cached < 0) && !turn.usageShrinkWarned) {
          turn.usageShrinkWarned = true;
          console.warn(
            '[CodexAppServer] cumulative token total shrank below the turn baseline; clamping usage to 0'
          );
        }
        turn.usage = {
          input_tokens: Math.max(0, input),
          output_tokens: Math.max(0, output),
          cache_read_input_tokens: Math.max(0, cached),
        };
        this.enforceTurnBudget(turn.threadId, turn);
      } else {
        // No cumulative total on this event: accumulate per-call usage.
        turn.usage = {
          input_tokens: turn.usage.input_tokens + num(last?.inputTokens),
          output_tokens: turn.usage.output_tokens + num(last?.outputTokens),
          cache_read_input_tokens:
            (turn.usage.cache_read_input_tokens ?? 0) + num(last?.cachedInputTokens),
        };
        this.enforceTurnBudget(turn.threadId, turn);
      }
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

  // ─── Codex-native subagents ───────────────────────────────────────────────
  //
  // Codex announces a child on the PARENT thread as a `subAgentActivity` item and then
  // drives the child on its OWN thread id, which outlives the parent turn. Nothing here
  // blocks a run. A child NEVER inherits the parent turn's bridge: the parent's envelope
  // expires with the parent's wall and the child cannot renew it, so a child that
  // inherited it would lose every tool mid-run and still report "done". The host issues
  // the child its own authority instead (`createSubagentBridge`), or the child has none
  // and its calls are refused loudly.

  /** Returns true when this notification belongs to the subagent surface and was consumed. */
  private handleSubagentNotification(method: string, threadId: string, data: JsonObject): boolean {
    if (method === 'item/started' || method === 'item/completed') {
      const item = object(data.item);
      if (item?.type === 'subAgentActivity') {
        // Only a thread this process actually drives may announce children.
        if (!this.subagents.has(threadId) && !this.threadContexts.has(threadId)) {
          return false;
        }
        if (item.kind === 'started') {
          this.registerSubagent(threadId, item);
        } else if (item.kind === 'completed') {
          this.observeParentSideCompletion(threadId, item);
        }
        return true;
      }
      const child = this.subagents.get(threadId);
      if (!child) {
        return false;
      }
      this.refreshParentTurnIdleTimeout(child);
      if (
        method === 'item/completed' &&
        item?.type === 'agentMessage' &&
        item.phase === 'final_answer' &&
        typeof item.text === 'string'
      ) {
        child.finalText = item.text.slice(0, SUBAGENT_FINAL_TEXT_LIMIT);
      }
      return true;
    }
    const child = this.subagents.get(threadId);
    if (!child) {
      return false;
    }
    this.refreshParentTurnIdleTimeout(child);
    if (method !== 'turn/completed') {
      return true;
    }
    const completed = object(data.turn);
    const status = completed?.status;
    if (status === 'inProgress') {
      return true;
    }
    if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') {
      return true;
    }
    if (!child.finalText) {
      child.finalText = this.subagentFinalText(completed?.items);
    }
    // The child's OWN turn/completed is the only completing event: the parent-side
    // announcement carries neither status nor result.
    this.finishSubagent(
      threadId,
      status,
      status === 'failed'
        ? this.redact(errorMessage(completed?.error, 'Codex app-server subagent turn failed'))
        : undefined
    );
    return true;
  }

  private subagentFinalText(items: unknown): string {
    if (!Array.isArray(items)) {
      return '';
    }
    let text = '';
    for (const entry of items) {
      const item = object(entry);
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        text = item.text;
      }
    }
    return text.slice(0, SUBAGENT_FINAL_TEXT_LIMIT);
  }

  /** A working child keeps the parent's idle timeout alive (the parent may be in wait_agent). */
  private refreshParentTurnIdleTimeout(child: SubagentState): void {
    const parentTurn = this.turns.get(child.parentThreadId);
    if (parentTurn) {
      this.refreshTurnIdleTimeout(parentTurn);
    }
  }

  /** Drop every thread context this session left behind on a previous thread id. */
  private pruneThreadContexts(sessionKey: string, currentThreadId: string): void {
    for (const [threadId, context] of this.threadContexts) {
      if (context.sessionKey === sessionKey && threadId !== currentThreadId) {
        this.threadContexts.delete(threadId);
      }
    }
  }

  private knownThreadIds(): Set<string> {
    const ids = new Set<string>(this.threadContexts.keys());
    for (const state of this.sessions.values()) {
      if (state.threadId) {
        ids.add(state.threadId);
      }
    }
    for (const threadId of this.turns.keys()) {
      ids.add(threadId);
    }
    return ids;
  }

  private registerSubagent(parentThreadId: string, item: JsonObject): void {
    const agentThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : '';
    if (!agentThreadId || this.subagents.has(agentThreadId)) {
      // The same `started` announcement arrives twice (item/started + item/completed views).
      return;
    }
    if (this.finishedSubagents.has(agentThreadId)) {
      // The second view of that announcement lost the race with the child's own
      // turn/completed. Re-registering would resurrect a finished child.
      console.warn(
        `[CodexAppServer] subagent announcement ignored: thread=${agentThreadId} already finished`
      );
      return;
    }
    // A child may never claim a thread this process already drives: that would let one
    // session's announcement capture another session's live parent thread.
    if (this.knownThreadIds().has(agentThreadId)) {
      console.warn(
        `[CodexAppServer] subagent announcement refused: thread=${agentThreadId} is a live thread`
      );
      return;
    }
    // A grandchild's session comes from the child that announced it.
    const parent = this.subagents.get(parentThreadId) ?? this.threadContexts.get(parentThreadId);
    if (!parent) {
      return;
    }
    const agentPath = typeof item.agentPath === 'string' ? item.agentPath : '';
    // Observed admission: tell the PARENT'S live turn that this run handed work to a
    // child. Nothing else on the item stream carries that fact - on codex-cli 0.153.4
    // a spawn surfaces ONLY as `subAgentActivity`, which this handler consumes before
    // the native-item path. Never routed through onToolUse (effect ledger, see
    // PromptCallbacks.onSubagentStart).
    const parentTurn = this.turns.get(parentThreadId);
    if (parentTurn?.onSubagentStart) {
      const itemId = typeof item.id === 'string' ? item.id : '';
      try {
        parentTurn.onSubagentStart({ agentThreadId, agentPath, itemId });
      } catch (error: unknown) {
        console.warn(
          `[CodexAppServer] onSubagentStart callback failed: ${this.toError(error).message}`
        );
      }
    }
    const factory = this.options.createSubagentBridge;
    const child: SubagentState = {
      parentThreadId,
      sessionKey: parent.sessionKey,
      agentPath,
      onToolUse: parent.onToolUse,
      onToolComplete: parent.onToolComplete,
      finalText: '',
      startedAt: Date.now(),
      toolCallQueue: Promise.resolve(),
      toolCallResults: new Map(),
      stoppingCallIds: new Set(),
      abortController: new AbortController(),
      authorityWarned: false,
      authority: factory
        ? factory({
            sessionKey: parent.sessionKey,
            parentThreadId,
            agentThreadId,
            agentPath,
          })
            .then((authority) => authority ?? null)
            .catch((error: unknown) => {
              console.warn(
                `[CodexAppServer] subagent authority factory failed thread=${agentThreadId}: ${
                  this.toError(error).message
                }`
              );
              return null;
            })
        : Promise.resolve(null),
    };
    child.ttlTimer = setTimeout(() => {
      child.ttlTimer = undefined;
      this.finishSubagent(agentThreadId, 'failed', 'subagent produced no completion');
    }, this.options.subagentTtlMs ?? SUBAGENT_TTL_MS);
    child.ttlTimer.unref();
    this.subagents.set(agentThreadId, child);
    console.log(`[CodexAppServer] subagent started path=${agentPath} thread=${agentThreadId}`);
    this.emitSubagentEvent({
      kind: 'started',
      sessionKey: parent.sessionKey,
      parentThreadId,
      agentThreadId,
      agentPath,
    });
  }

  /**
   * The parent says a child finished. That is an announcement, not a result: it can win
   * the race against the child's own `turn/completed`, which is what carries status and
   * final text. Wait a bounded grace for the real event, then report `unknown`.
   */
  private observeParentSideCompletion(announcingThreadId: string, item: JsonObject): void {
    const agentThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : '';
    const child = agentThreadId ? this.subagents.get(agentThreadId) : undefined;
    if (!child) {
      return;
    }
    if (child.parentThreadId !== announcingThreadId) {
      console.warn(
        `[CodexAppServer] subagent completion refused: thread=${announcingThreadId} does not own ${agentThreadId}`
      );
      return;
    }
    if (child.graceTimer) {
      return;
    }
    child.graceTimer = setTimeout(() => {
      child.graceTimer = undefined;
      console.warn(
        `[CodexAppServer] subagent completion unconfirmed path=${child.agentPath} thread=${agentThreadId}`
      );
      this.finishSubagent(agentThreadId, 'unknown');
    }, this.options.subagentGraceMs ?? SUBAGENT_COMPLETION_GRACE_MS);
    child.graceTimer.unref();
  }

  /**
   * Emits exactly one completion per child thread and releases its authority with the
   * same terminal status. Grandchildren keep their own entries.
   */
  private finishSubagent(
    agentThreadId: string,
    status: NonNullable<SubagentEvent['status']>,
    error?: string
  ): void {
    const child = this.subagents.get(agentThreadId);
    if (!child) {
      return;
    }
    this.subagents.delete(agentThreadId);
    this.rememberFinishedSubagent(agentThreadId);
    this.clearSubagentTimers(child);
    console.log(
      `[CodexAppServer] subagent completed status=${status} path=${child.agentPath} thread=${agentThreadId}`
    );
    const finalText = child.finalText ? this.redact(child.finalText) : '';
    this.emitSubagentEvent({
      kind: 'completed',
      sessionKey: child.sessionKey,
      parentThreadId: child.parentThreadId,
      agentThreadId,
      agentPath: child.agentPath,
      status,
      ...(finalText ? { finalText } : {}),
      ...(error ? { error } : {}),
    });
    void child.authority
      .then(async (authority) => {
        if (!authority) {
          return;
        }
        await authority.release({ status, ...(error ? { error } : {}) });
      })
      .catch((releaseError: unknown) => {
        console.warn(
          `[CodexAppServer] subagent authority release failed thread=${agentThreadId}: ${
            this.toError(releaseError).message
          }`
        );
      });
  }

  /** FIFO-bounded identity of finished children; the oldest id is forgotten first. */
  private rememberFinishedSubagent(agentThreadId: string): void {
    this.finishedSubagents.add(agentThreadId);
    while (this.finishedSubagents.size > MAX_FINISHED_SUBAGENTS) {
      const oldest = this.finishedSubagents.values().next().value;
      if (oldest === undefined) {
        return;
      }
      this.finishedSubagents.delete(oldest);
    }
  }

  private clearSubagentTimers(child: SubagentState): void {
    if (child.ttlTimer) {
      clearTimeout(child.ttlTimer);
      child.ttlTimer = undefined;
    }
    if (child.graceTimer) {
      clearTimeout(child.graceTimer);
      child.graceTimer = undefined;
    }
  }

  private emitSubagentEvent(event: SubagentEvent): void {
    const emit = this.options.onSubagentEvent;
    if (!emit) {
      return;
    }
    try {
      emit(event);
    } catch (error: unknown) {
      console.warn(
        `[CodexAppServer] subagent event listener failed: ${this.toError(error).message}`
      );
    }
  }

  /** Every live child is reported interrupted and its authority released. */
  private terminateSubagents(reason: Error): void {
    const safe = this.toError(reason);
    for (const agentThreadId of [...this.subagents.keys()]) {
      const child = this.subagents.get(agentThreadId);
      if (!child) {
        continue;
      }
      child.abortController.abort(safe);
      this.finishSubagent(agentThreadId, 'interrupted', safe.message);
    }
  }

  /** A reset/restart drops the thread's context and interrupts its children. */
  private discardSessionThreadState(sessionKey: string, reason: string): void {
    const threadId = this.sessions.get(sessionKey)?.threadId;
    if (threadId) {
      this.threadContexts.delete(threadId);
    }
    for (const agentThreadId of [...this.subagents.keys()]) {
      const child = this.subagents.get(agentThreadId);
      if (!child || child.sessionKey !== sessionKey) {
        continue;
      }
      child.abortController.abort(new Error(`Codex app-server ${reason}`));
      this.finishSubagent(agentThreadId, 'interrupted', reason);
    }
  }

  private handleSubagentToolRequest(
    request: ServerToolRequest,
    agentThreadId: string,
    child: SubagentState,
    data: JsonObject
  ): void {
    this.refreshParentTurnIdleTimeout(child);
    // The child's authority is host-issued and asynchronous; its calls queue until it
    // resolves rather than falling back to anything the parent held.
    void child.authority.then((authority) => {
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
        if (!authority) {
          if (!child.authorityWarned) {
            child.authorityWarned = true;
            console.warn(
              `[CodexAppServer] ${SUBAGENT_AUTHORITY_UNAVAILABLE} path=${child.agentPath} thread=${agentThreadId}`
            );
          }
          this.replyToolError(request, `${SUBAGENT_AUTHORITY_UNAVAILABLE}: ${tool} was refused`);
          return;
        }
        const bridge = authority.bridge;
        if (!bridge.tools.some((definition) => definition.name === tool)) {
          throw new Error(`Codex app-server tool call ${tool} was not advertised`);
        }
        this.dispatchSubagentToolCall(request, agentThreadId, child, bridge, {
          turnId,
          callId,
          tool,
          namespace: data.namespace ?? null,
          input,
        });
      } catch (error: unknown) {
        // A child's protocol error is reported to the child only: the parent turn it was
        // spawned from may already have resolved, and there is nothing here to fail.
        this.replyToolError(request, this.toError(error).message);
      }
    });
  }

  private dispatchSubagentToolCall(
    request: ServerToolRequest,
    agentThreadId: string,
    child: SubagentState,
    bridge: HostToolBridge,
    call: {
      turnId: string;
      callId: string;
      tool: string;
      namespace: string | null;
      input: JsonObject;
    }
  ): void {
    const { turnId, callId, tool, namespace, input } = call;
    const identity = JSON.stringify(
      stableJson({ threadId: agentThreadId, turnId, tool, namespace, arguments: input })
    );
    const existing = child.toolCallResults.get(callId);
    if (existing && existing.identity !== identity) {
      throw new Error(`Codex app-server callId ${callId} had a conflicting request`);
    }
    let execution = existing?.execution;
    if (!execution) {
      execution = child.toolCallQueue
        .then(async () => {
          if (!this.isSubagentToolActive(request, agentThreadId, child)) {
            return {
              result: this.toolResult(false, 'Codex app-server tool call is no longer active'),
              stop: false,
              abortError: undefined,
            };
          }
          try {
            child.onToolUse?.(tool, {
              nativeToolUseId: callId,
              subagentThreadId: agentThreadId,
              agentPath: child.agentPath,
            });
          } catch (error: unknown) {
            console.warn(
              `[CodexAppServer] subagent onToolUse failed: ${this.toError(error).message}`
            );
          }
          let result: unknown;
          try {
            result = await bridge.execute({
              callId,
              name: tool,
              input,
              signal: child.abortController.signal,
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
            this.reportSubagentToolComplete(child, tool, callId, true);
            return {
              result: this.toolResult(false, 'Host tool returned a malformed result'),
              stop: false,
              abortError: undefined,
            };
          }
          this.reportSubagentToolComplete(child, tool, callId, resultData.isError);
          if (resultData.isError && resultData.content.includes(ENVELOPE_EXPIRED_MARKER)) {
            // Expired authority is named, never silently downgraded to a plain failure:
            // a child whose grant ran out must not read as work that merely did not apply.
            return {
              result: this.toolResult(
                false,
                `${SUBAGENT_AUTHORITY_EXPIRED}: ${resultData.content}`
              ),
              stop: false,
              abortError: undefined,
            };
          }
          return {
            result: this.toolResult(!resultData.isError, resultData.content),
            stop: resultData.stop === true || resultData.abort === true,
            abortError: undefined,
          };
        })
        .catch((error: unknown) => ({
          result: this.toolResult(false, this.toError(error).message),
          stop: false,
          abortError: undefined,
        }));
      child.toolCallResults.set(callId, { identity, execution });
      child.toolCallQueue = execution.then(
        () => undefined,
        () => undefined
      );
    }
    void execution.then(({ result, stop }) => {
      if (!this.isSubagentToolActive(request, agentThreadId, child)) {
        if (this.child === request.child) {
          this.replyToolError(request, 'Codex app-server tool call is no longer active');
        }
        return;
      }
      this.reply(request.child, { jsonrpc: '2.0', id: request.id, result });
      if (stop && !child.stoppingCallIds.has(callId)) {
        child.stoppingCallIds.add(callId);
        child.abortController.abort(new Error('Codex app-server subagent tool stopped the run'));
        void this.request('turn/interrupt', { threadId: agentThreadId, turnId }).catch(
          (error: unknown) =>
            console.warn(
              `[CodexAppServer] subagent interrupt failed: ${this.toError(error).message}`
            )
        );
      }
    });
  }

  private reportSubagentToolComplete(
    child: SubagentState,
    tool: string,
    callId: string,
    isError: boolean
  ): void {
    try {
      child.onToolComplete?.(tool, callId, isError);
    } catch (error: unknown) {
      console.warn(
        `[CodexAppServer] subagent onToolComplete failed: ${this.toError(error).message}`
      );
    }
  }

  private isSubagentToolActive(
    request: ServerToolRequest,
    agentThreadId: string,
    child: SubagentState
  ): boolean {
    return (
      this.child === request.child &&
      this.subagents.get(agentThreadId) === child &&
      !child.abortController.signal.aborted
    );
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
    if (data && threadId && !turn && !expectedTurn) {
      // A Codex-native child calls on ITS OWN thread id, which never holds a PendingTurn.
      const child = this.subagents.get(threadId);
      if (child) {
        this.handleSubagentToolRequest(request, threadId, child, data);
        return;
      }
    }
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

  /** Interrupt a turn whose counted usage crossed its run budget; the loop reports stoppedBy. */
  private enforceTurnBudget(
    threadId: string,
    turn: {
      runTokenBudget?: number;
      budgetStopped?: boolean;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
    }
  ): void {
    const budget = turn.runTokenBudget ?? 0;
    if (budget <= 0 || turn.budgetStopped) {
      return;
    }
    // Codex reports inputTokens INCLUSIVE of cachedInputTokens (OpenAI usage semantics),
    // so cached is not added again: 0.44.0 counted a 2.8M wiki turn as 5.5M.
    const counted = turn.usage.input_tokens + turn.usage.output_tokens;
    if (counted < budget) {
      return;
    }
    turn.budgetStopped = true;
    const error = new Error(
      `run budget stop: ${counted} >= ${budget} counted tokens inside one turn`
    );
    (error as Error & { code?: string }).code = 'RUN_BUDGET_STOP';
    // The interrupted turn's usage rides on the error: the loop's success path never
    // runs for it, and the most expensive run of the day must not count as zero.
    (error as Error & { usage?: unknown }).usage = { ...turn.usage };
    this.timeoutTurn(threadId, error, DEFAULT_TIMEOUT);
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
    // Pending child tool calls abort exactly like a parent turn's.
    for (const child of this.subagents.values()) {
      child.abortController.abort(safe);
    }
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
    // The connection is gone, so every child is gone with it: say so once per child and
    // release its authority instead of dropping the registry silently.
    this.terminateSubagents(new Error('Codex app-server connection closed'));
    this.threadContexts.clear();
    this.lateTurnStarts.clear();
    for (const [threadId, reconciliation] of this.turnStartReconciliations) {
      this.completeTurnStartReconciliation(threadId, reconciliation);
    }
  }
}
