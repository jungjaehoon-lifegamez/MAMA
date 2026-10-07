/**
 * The harness protocol — what a model runtime and this system say to each
 * other.
 *
 * These names were split out of the product's agent/types.ts and
 * model-runner.ts so the drivers beside this file could move without dragging
 * the twenty-two file closure those two modules sit in. The product keeps both
 * modules and re-exports these from here, so there is one definition.
 *
 * Nothing here knows a product: a tool exchange, a prompt, a runner's metrics
 * and the errors a host tool can raise are the same shapes whichever daemon
 * opens the session.
 */

/**
 * Tool use content block (Claude requesting tool execution)
 */
export interface PromptTerminalError {
  code: 'MUTATION_COMMITTED_AFTER_ABORT' | 'MUTATION_OUTCOME_UNKNOWN' | 'TOOL_CONTRACT_REPEAT';
  message: string;
}

/**
 * Common response shape passed to onFinal callbacks.
 * Both PersistentCLI and Codex app-server normalize their output to this format.
 */
export interface PromptFinalResponse {
  content: string;
  toolUseBlocks: ToolUseBlock[];
}

/**
 * Backend type identifier.
 */
export type HostToolJsonValue =
  | null
  | boolean
  | number
  | string
  | HostToolJsonValue[]
  | { [key: string]: HostToolJsonValue };

export type BackendType = 'claude' | 'codex';

/** Native acknowledgement only: neither model completion nor an effect receipt. */
export type NativeInputReceipt =
  | { backend: 'codex'; sessionId: string; turnId: string }
  | { backend: 'claude'; sessionId: string; inputId: string };

/** The caller's stable invocation ID and native address, recorded before transport write. */
export interface NativeInputDispatch {
  backend: BackendType;
  sessionId: string;
  inputId: string;
}

export class NativeInputUncertainError extends Error {
  readonly retryable = false;
  readonly code = 'NATIVE_INPUT_UNCERTAIN';
  constructor(
    message: string,
    readonly target: NativeInputReceipt | NativeInputDispatch,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'NativeInputUncertainError';
  }
}

/** The exact steering target vanished before anything was written to native transport. */
export class NativeSteeringTargetUnavailableError extends Error {
  readonly code = 'NATIVE_STEERING_TARGET_UNAVAILABLE';
  constructor() {
    super('Native steering requires the matching active turn');
    this.name = 'NativeSteeringTargetUnavailableError';
  }
}

export interface HostToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, HostToolJsonValue>>;
  readonly required?: readonly string[];
  readonly additionalProperties: boolean;
  readonly oneOf?: readonly HostToolJsonValue[];
}

/** A dynamic function call received from the model host. */
export interface HostToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** Aborted when the owning model turn fails, times out, or is disconnected. */
  signal?: AbortSignal;
}

export type HostToolTerminalCode =
  | 'MUTATION_COMMITTED_AFTER_ABORT'
  | 'MUTATION_OUTCOME_UNKNOWN'
  | 'TOOL_CONTRACT_REPEAT';

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result content block (response to tool_use)
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface CompletedToolExchange {
  toolUse: ToolUseBlock;
  toolResult: ToolResultBlock;
}

export interface PromptResult {
  response: string;
  usage: Partial<Usage>;
  session_id: string;
  cost_usd?: number;
  /** Only tool uses that still require host execution. */
  toolUseBlocks?: ToolUseBlock[];
  hasToolUse?: boolean;
  /** Host-completed MCP exchanges observed on the Claude stream, in result order. */
  completedToolExchanges?: CompletedToolExchange[];
  /** Trusted terminal mutation outcome decoded from a completed local MCP exchange. */
  terminalError?: PromptTerminalError;
  duration_ms?: number;
}

export class ClaudeToolStreamProtocolError extends Error {
  readonly code = 'CLAUDE_TOOL_STREAM_PROTOCOL';

  constructor(message: string) {
    super(message);
    this.name = 'ClaudeToolStreamProtocolError';
  }
}

/**
 * Callbacks for PersistentCLI / Codex app-server prompt calls.
 * Shared across all backend adapters to avoid duplicate definitions.
 */
export interface PromptCallbacks {
  /** Must complete before the driver writes this input to the native transport. */
  onInputDispatch?: (input: NativeInputDispatch) => void;
  /** Emitted from the native input acknowledgement, before its final result. */
  onAccepted?: (receipt: NativeInputReceipt) => void;
  onDelta?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  /** unknown means the child ended without a matching tool result. */
  onToolComplete?: (tool: string, toolUseId: string, isError: boolean, outcome?: 'unknown') => void;
  /**
   * A native subagent was announced on this run's own thread. Admission, not an
   * external effect: it deliberately does NOT travel through onToolUse, because
   * onToolUse writes a `native_tool` row into the owner effect ledger and any such
   * row marks the occurrence unsafe to replay. A spawn must never do that.
   */
  onSubagentStart?: (info: { agentThreadId: string; agentPath: string; itemId: string }) => void;
  /**
   * The runner's OWN later turn answered on behalf of this request: the CLI's follow-up
   * after a child spawned here finished, or after a task notification no tracked child
   * claimed. That text is a later answer to the same request and must reach whoever asked;
   * measured 2026-09-10 it otherwise had no reader.
   */
  onFollowUp?: (info: {
    agentThreadId: string;
    agentPath: string;
    itemId: string;
    text: string;
    isError: boolean;
  }) => void;
  onFinal?: (response: PromptFinalResponse) => void;
  onError?: (error: Error) => void;
}

/**
 * Token usage record for tracking API consumption
 */
export interface TokenUsageRecord {
  channel_key: string;
  agent_id?: string;
  agent_version?: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cost_usd?: number;
}

/** Codex app-server dynamic function definition. */
export interface HostToolDefinition {
  type: 'function';
  name: string;
  description: string;
  inputSchema: HostToolInputSchema;
}

/** Serialized result returned to the model host. */
export interface HostToolCallResult {
  content: string;
  isError: boolean;
  stop?: boolean;
  /** Fail the active model turn after returning this error result to the host. */
  abort?: boolean;
  /** Trusted host-tool terminal code; never derived from model-visible text. */
  terminalCode?: HostToolTerminalCode;
}

/** Tools and executor scoped to one prompt run. */
export interface HostToolBridge {
  readonly tools: readonly HostToolDefinition[];
  execute(call: HostToolCall): Promise<HostToolCallResult>;
}

export function isHostToolTerminalCode(value: unknown): value is HostToolTerminalCode {
  return (
    value === 'MUTATION_COMMITTED_AFTER_ABORT' ||
    value === 'MUTATION_OUTCOME_UNKNOWN' ||
    value === 'TOOL_CONTRACT_REPEAT'
  );
}

/** Typed transport for a trusted host-tool terminal result across model runtimes. */
export class HostToolTerminalError extends Error {
  readonly retryable = false;

  constructor(
    readonly terminalCode: HostToolTerminalCode,
    message: string,
    readonly completedToolExchanges?: readonly CompletedToolExchange[]
  ) {
    super(message);
    this.name = 'HostToolTerminalError';
  }
}

/** A host tool deliberately stopped a run without claiming a terminal mutation outcome. */
export class HostToolAbortError extends Error {
  readonly retryable = false;

  constructor(
    message: string,
    readonly completedToolExchanges: readonly CompletedToolExchange[]
  ) {
    super(message);
    this.name = 'HostToolAbortError';
  }
}

/**
 * Options passed to prompt() that are backend-agnostic.
 */
export interface PromptOptions {
  /** Called after the backend settles its actual session, before any input is dispatched. */
  preparePrompt?: (session: NativeSessionState) => Promise<string>;
  /** Stable, caller-persisted native invocation UUID; not the model session routing key. */
  nativeInputId?: string;
  model?: string;
  resumeSession?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Allow the backend's native single-agent delegation primitive for this route. */
  allowSpawnAgent?: boolean;
  /** Allow the backend's native multi-agent team primitive for this route. */
  allowAgentTeams?: boolean;
  /**
   * Per-call Claude builtin tool set (--tools) resolved from this turn's role.
   * Undefined keeps the pool's construction-time default; '' means no builtins.
   */
  tools?: string;
  hostToolBridge?: HostToolBridge;
  /** Per-run counted-token budget; enforced inside a codex turn (see CodexAppServerProcess). */
  runTokenBudget?: number;
  systemPrompt?: string;
  /** Native working directory for this call; a restricted thread keeps it inside its read roots. */
  cwd?: string;
  /** Stable source/channel route used by persistent backends across daemon restarts. */
  sessionKey?: string;
  /** Stable identity/rules fingerprint, excluding dynamic conversation context. */
  sessionPolicyFingerprint?: string;
  /** Optional native thread/turn read boundary. The host states real roots. */
  restrictedReadRoots?: readonly string[];
  /**
   * Pool ROUTING key (SessionPool id) for THIS call, NOT the CLI --session-id.
   * The pool spawns processes with its own randomUUID() so the CLI never
   * reloads disk history. Routes this prompt to this session's process
   * without mutating shared adapter state.
   */
  sessionId?: string;
  /**
   * Per-call CLI request timeout (ms) applied when this call spawns a fresh
   * pooled process. Undefined leaves the pool's construction-time default in
   * place, so only callers that opt in (operator worker runs) are affected.
   */
  requestTimeout?: number;
  /** Host-issued authority for this exact prompt attempt; persistent Claude binds it to MCP. */
  /**
   * Host-issued authority for this exact prompt attempt. A driver carries it
   * to the tool bridge and reads exactly one field off it — the owning turn's
   * cancellation — so that is all the protocol states. The rest of the shape
   * belongs to whoever composes it.
   */
  toolExecutionContext?: HostExecutionContext | null;
  /**
   * Rebuilds the FULL instructions for a backend that has to rehydrate a durable
   * session on this call. Codex re-anchors the resumed thread with them
   * (thread/resume accepts baseInstructions) instead of replaying a per-call prompt
   * as user text. Lazy: backends invoke it only when a resume actually happens, so
   * live sessions never pay the rebuild.
   */
  resumeInstructions?: () => Promise<string>;
  /** Measurement only: host lane and brief state for the per-turn [prompt] log line. */
  promptTelemetry?: { kind: string; brief: 'sent' | 'omitted' };
}

export type SessionPolicyStatus = 'missing' | 'compatible' | 'mismatch';

/** Actual native context, not the host's session-pool routing hint. */
export interface NativeSessionState {
  sessionId: string;
  isNewSession: boolean;
}

/** The native protocol explicitly rejected resumption because its context no longer exists. */
export class NativeSessionUnavailableError extends Error {}

/**
 * Runtime metrics collected by a model runner.
 */
export interface RunnerMetrics {
  requestCount: number;
  failureCount: number;
  avgLatencyMs: number;
  lastRequestAt: number | null;
}

/**
 * Standardized error categories for backend failures.
 */
export type ModelRunnerErrorCode =
  | 'timeout'
  | 'crash'
  | 'context_overflow'
  | 'auth_failure'
  | 'rate_limit'
  | 'unknown';

/**
 * Typed error thrown by IModelRunner implementations.
 */
export class ModelRunnerError extends Error {
  readonly code: ModelRunnerErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: ModelRunnerErrorCode, retryable = false) {
    super(message);
    this.name = 'ModelRunnerError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Unified model runner interface.
 *
 * Both PersistentCLIAdapter (Claude) and CodexRuntimeProcess (Codex)
 * implement this contract so AgentLoop is backend-agnostic.
 */
export interface IModelRunner {
  /** Backend identifier */
  readonly backendType: BackendType;

  /**
   * Whether THIS runner can spawn a native subagent the host can observe.
   *
   * A contract that asks for delegation is only honest on a runner that has the primitive
   * AND a spawn observation path: codex app-server has both (`onSubagentStart`). The
   * persistent Claude CLI persona runs with `--tools ""` (no native Agent tool) and has no
   * subagent stream, and some adapters have neither - on those, a "spawn one subagent"
   * instruction can only be wasted steps or a reported failure. Read this capability rather
   * than string-matching a backend name.
   */
  readonly supportsNativeSubagents: boolean;

  /**
   * Whether a turn on THIS runner can be recorded as a model run.
   *
   * Absent or true means yes, which is the ordinary case: the record is the host's
   * ledger entry about a turn that happened, so anything that actually runs one can
   * be recorded. A runner sets this false only when it truthfully cannot stand behind
   * a run - a double that returns canned text, for instance.
   *
   * It is stated HERE, by the driver, and nowhere else. It used to be inferred from
   * whether the consumer's tools reached the host through a gateway, which is a fact
   * about tool routing and not about whether a turn happened: the installed Claude
   * MCP backend ran six tools, sent an owner report, and left the delivery unable to
   * name the run that wrote it (`no_run_handle`, 2026-09-22).
   */
  readonly reportsModelRuns?: boolean;

  /** Send a prompt and receive a response */
  prompt(
    content: string,
    callbacks?: PromptCallbacks,
    options?: PromptOptions
  ): Promise<PromptResult>;

  /** Only a native steering primitive may implement this; do not emulate it with another prompt. */
  steer?(
    content: string,
    target: NativeInputReceipt,
    options?: Pick<PromptOptions, 'sessionKey' | 'sessionId'> & { beforeSend?: () => void }
  ): Promise<NativeInputReceipt>;

  /** Read-only durable-session policy preflight. Codex uses this to rotate before a request. */
  getSessionPolicyStatus?(options: PromptOptions): SessionPolicyStatus;

  /** Retire one exact routed backend session before replacing its authority policy. */
  resetSession?(sessionId?: string, sessionKey?: string): void | Promise<void>;

  /** Set the session/channel ID */
  setSessionId(id: string): void;

  /** Set or update the system prompt (affects new processes only) */
  setSystemPrompt(prompt: string): void;

  /**
   * Send a tool result back to the model (Claude-specific).
   * Optional: Codex backends may leave this unimplemented.
   */
  sendToolResult?(
    toolUseId: string,
    result: string,
    isError?: boolean,
    callbacks?: PromptCallbacks
  ): Promise<PromptResult>;

  /** Check if the runner is alive and ready to accept prompts */
  isHealthy(): boolean;

  /** Collect runtime metrics */
  getMetrics(): RunnerMetrics;

  /** Gracefully stop all processes */
  stop(): void | Promise<void>;
}

/**
 * The host's per-attempt authority as anything below the host sees it: an
 * opaque record that carries the owning turn's cancellation. A driver or a
 * hook hands it on and reads nothing else off it, so the rest of the shape
 * stays with whoever composes it.
 */
export type HostExecutionContext = { signal?: AbortSignal } & Record<string, unknown>;

export type AgentErrorCode =
  | 'API_ERROR'
  | 'CLI_ERROR'
  | 'AGENT_STOPPED'
  | 'AUTH_ERROR'
  | 'RATE_LIMIT'
  | 'MAX_TOKENS'
  | 'MAX_TURNS'
  | 'EMERGENCY_MAX_TURNS'
  | 'INFINITE_LOOP_DETECTED'
  | 'NETWORK_ERROR'
  | 'TOOL_ERROR'
  | 'UNKNOWN_TOOL'
  | 'INVALID_RESPONSE'
  | 'ENVELOPE_EXPIRED'
  | 'WORKORDER_SUPERSEDED'
  | 'CLAUDE_TOOL_STREAM_PROTOCOL'
  | 'MUTATION_COMMITTED_AFTER_ABORT'
  | 'MUTATION_OUTCOME_UNKNOWN'
  | 'TOOL_CONTRACT_REPEAT'
  | 'relationship_target_unavailable';

/**
 * A failure raised anywhere on the harness path. The code is what a caller
 * reads; `retryable` says whether trying again could differ.
 */
export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: AgentErrorCode,
    public readonly cause?: Error,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

// --- The conversation a harness exchanges ---
// Blocks and messages are what every driver below sends and receives. They were
// declared in one product because that product was written first.

export type MessageRole = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

/** Image source for base64 encoded images. */
export interface ImageSourceBase64 {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

/** Image content block for multimodal input. */
export interface ImageBlock {
  type: 'image';
  source: ImageSourceBase64;
}

/** Document content block for document understanding. */
export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock | ToolUseBlock | ToolResultBlock;

/** One message in conversation history. */
export interface Message {
  role: MessageRole;
  content: ContentBlock[] | string;
}

/** Why the model stopped producing this turn. */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/** Token accounting one turn reports back. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  compaction_count?: number;
  cost_usd?: number;
}

/** One assistant response as the harness hands it back. */
export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: Usage;
}

/** What a turn observer is told about a turn that just finished. */
export interface TurnInfo {
  turn: number;
  role: MessageRole;
  content: ContentBlock[];
  stopReason?: StopReason;
  usage?: Usage;
}

/** Streaming callbacks are the same shape a prompt already takes. */
export type StreamCallbacks = PromptCallbacks;

/** Which door a tool call came through. */
export type GatewayExecutionSurface = 'model_tool' | 'reactive_internal' | 'direct';
