/**
 * Runner Types
 *
 * Defines common interfaces for Embedded and CLI runners.
 * Enables dual runner architecture for MAMA Standalone.
 */

/**
 * Runner types
 */
export type RunnerType = 'embedded' | 'cli';

/**
 * Options for running a prompt
 */
export interface RunnerOptions {
  /** Model to use (e.g., "opus", "sonnet") */
  model?: string;
  /** System prompt to prepend */
  systemPrompt?: string;
  /** Session ID for conversation continuity */
  sessionId?: string;
  /** Working directory for CLI execution */
  workspaceDir?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Result from a runner execution
 */
export interface RunnerResult {
  /** Response text */
  text: string;
  /** Session ID returned from CLI (for continuity) */
  sessionId?: string;
  /** Token usage statistics */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Common runner interface
 */
export interface Runner {
  /** Runner type identifier */
  readonly type: RunnerType;

  /**
   * Run a prompt and get response
   *
   * @param prompt - User prompt
   * @param options - Runner options
   * @returns Promise resolving to runner result
   */
  run(prompt: string, options?: RunnerOptions): Promise<RunnerResult>;
}

/**
 * CLI Backend configuration
 * Based on OpenClaw's cli-backends.js
 */
export interface CliBackendConfig {
  /** CLI command to execute (e.g., "claude") */
  command: string;

  /** Base arguments for the command */
  args: string[];

  /** Argument for specifying model */
  modelArg?: string;

  /** Argument for specifying session ID */
  sessionArg?: string;

  /** Argument for appending system prompt */
  systemPromptArg?: string;

  /** Timeout in milliseconds (default: 120000) */
  timeoutMs?: number;

  /** Whether to serialize (queue) CLI calls */
  serialize?: boolean;

  /** Model aliases (e.g., "opus" → "claude-opus-4") */
  modelAliases?: Record<string, string>;
}

/**
 * Default Claude Code CLI backend configuration
 */
export const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: 'claude',
  args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
  modelArg: '--model',
  sessionArg: '--session-id',
  systemPromptArg: '--append-system-prompt',
  timeoutMs: 120000,
  serialize: true,
  modelAliases: {
    opus: 'opus',
    'opus-4.5': 'opus',
    'opus-4': 'opus',
    sonnet: 'sonnet',
    'sonnet-4': 'sonnet',
    haiku: 'haiku',
    'haiku-3.5': 'haiku',
  },
};
