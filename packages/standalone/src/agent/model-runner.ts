/**
 * IModelRunner — Unified interface for CLI backends (STORY-011)
 *
 * Abstracts over Claude (PersistentCLI) and Codex (MCP) backends
 * so AgentLoop depends on a contract, not concrete implementations.
 */

import type { PromptCallbacks, ToolUseBlock } from './types.js';

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
}

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
export type BackendType = 'claude' | 'codex-mcp';

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
  stop(): void;
}
