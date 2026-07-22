/**
 * IModelRunner — Unified interface for CLI backends (STORY-011)
 *
 * Abstracts over Claude (PersistentCLI) and Codex (app-server) backends
 * so AgentLoop depends on a contract, not concrete implementations.
 */

import type { PromptCallbacks, ToolUseBlock } from './types.js';

// ─── Run-local Host Tools ───────────────────────────────────────────────────

export type HostToolJsonValue =
  | null
  | boolean
  | number
  | string
  | HostToolJsonValue[]
  | { [key: string]: HostToolJsonValue };

export interface HostToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, HostToolJsonValue>>;
  readonly required?: readonly string[];
  readonly additionalProperties: boolean;
}

/** Codex app-server dynamic function definition. */
export interface HostToolDefinition {
  type: 'function';
  name: string;
  description: string;
  inputSchema: HostToolInputSchema;
}

/** A dynamic function call received from the model host. */
export interface HostToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** Aborted when the owning model turn fails, times out, or is disconnected. */
  signal?: AbortSignal;
}

/** Serialized result returned to the model host. */
export interface HostToolCallResult {
  content: string;
  isError: boolean;
  stop?: boolean;
  /** Fail the active model turn after returning this error result to the host. */
  abort?: boolean;
  /** Trusted terminal mutation code; never derived from model-visible text. */
  terminalCode?: HostToolTerminalCode;
}

/** Tools and executor scoped to one prompt run. */
export interface HostToolBridge {
  readonly tools: readonly HostToolDefinition[];
  execute(call: HostToolCall): Promise<HostToolCallResult>;
}

export type HostToolTerminalCode =
  | 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT'
  | 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN';

export function isHostToolTerminalCode(value: unknown): value is HostToolTerminalCode {
  return (
    value === 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT' ||
    value === 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN'
  );
}

/** Typed transport for a trusted host-tool terminal result across Codex app-server. */
export class HostToolTerminalError extends Error {
  readonly retryable = false;

  constructor(
    readonly terminalCode: HostToolTerminalCode,
    message: string
  ) {
    super(message);
    this.name = 'HostToolTerminalError';
  }
}

// ─── Result Types ────────────────────────────────────────────────────────────

/**
 * Standardized prompt result returned by all backends.
 */
export interface PromptResult {
  response: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  session_id: string;
  cost_usd?: number;
  toolUseBlocks?: ToolUseBlock[];
  hasToolUse?: boolean;
}

/**
 * Options passed to prompt() that are backend-agnostic.
 */
export interface PromptOptions {
  model?: string;
  resumeSession?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  hostToolBridge?: HostToolBridge;
  systemPrompt?: string;
  /** Stable source/channel route used by persistent backends across daemon restarts. */
  sessionKey?: string;
  /** Stable identity/rules fingerprint, excluding dynamic conversation context. */
  sessionPolicyFingerprint?: string;
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
}

export type SessionPolicyStatus = 'missing' | 'compatible' | 'mismatch';

// ─── Metrics ─────────────────────────────────────────────────────────────────

/**
 * Runtime metrics collected by a model runner.
 */
export interface RunnerMetrics {
  requestCount: number;
  failureCount: number;
  avgLatencyMs: number;
  lastRequestAt: number | null;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

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

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * Backend type identifier.
 */
export type BackendType = 'claude' | 'codex';

/**
 * Unified model runner interface.
 *
 * Both PersistentCLIAdapter (Claude) and CodexRuntimeProcess (Codex)
 * implement this contract so AgentLoop is backend-agnostic.
 */
export interface IModelRunner {
  /** Backend identifier */
  readonly backendType: BackendType;

  /** Send a prompt and receive a response */
  prompt(
    content: string,
    callbacks?: PromptCallbacks,
    options?: PromptOptions
  ): Promise<PromptResult>;

  /** Read-only durable-session policy preflight. Codex uses this to rotate before a request. */
  getSessionPolicyStatus?(options: PromptOptions): SessionPolicyStatus;

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
