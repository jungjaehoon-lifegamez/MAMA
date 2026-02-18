/**
 * Persistent Claude CLI Process - Keeps Claude alive for multi-turn conversations
 *
 * WHY THIS EXISTS:
 * - Previous approach spawned new Claude CLI process for each message
 * - Each spawn required ~20K system prompt to be sent every time
 * - Result: Slow responses (16-30 seconds per message)
 *
 * NEW ARCHITECTURE:
 * - Keep Claude process alive using stream-json input/output
 * - Send messages via stdin, receive responses via stdout
 * - Session memory preserved in Claude's context
 * - System prompt sent only once at process start
 *
 * STREAM-JSON PROTOCOL:
 * Input (stdin):
 *   User message: {"type":"user","message":{"role":"user","content":"..."}}
 *   Tool result:  {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"xxx","content":"...","is_error":false}]}}
 *
 * Output (stdout):
 *   Init:      {"type":"system","subtype":"init",...}
 *   Assistant: {"type":"assistant","message":{...}}
 *   Tool use:  Content block with type="tool_use" in assistant message
 *   Result:    {"type":"result","subtype":"success",...}
 */

import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import os from 'os';
import { EventEmitter } from 'events';
import type { TokenUsageRecord } from './types.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const persistentLogger = new DebugLogger('PersistentCLI');
const poolLogger = new DebugLogger('ProcessPool');

function supportsThinkingEffortModel(model: string | undefined): boolean {
  return model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6';
}

function normalizeThinkingEffort(
  model: string | undefined,
  effort: 'low' | 'medium' | 'high' | 'max'
): 'low' | 'medium' | 'high' | 'max' {
  if (effort === 'max' && model !== 'claude-opus-4-6') {
    return 'high';
  }
  return effort;
}

/**
 * Regex to strip lone Unicode surrogates that cause API 400 errors.
 * Matches high surrogates not followed by a low surrogate, and
 * low surrogates not preceded by a high surrogate.
 */
// eslint-disable-next-line no-control-regex
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface PersistentProcessOptions {
  sessionId: string;
  model?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  /**
   * Skip permission prompts for tool execution
   *
   * @warning SECURITY RISK: Bypasses all permission checks.
   * Only enable in trusted environments where agent actions are pre-approved.
   */
  dangerouslySkipPermissions?: boolean;
  useGatewayTools?: boolean;
  /** Timeout for each request in ms (default: 120000) */
  requestTimeout?: number;
  /** Environment variables to pass to the Claude CLI process */
  env?: Record<string, string>;
  /** Structurally allowed tools (--allowedTools CLI flag) */
  allowedTools?: string[];
  /** Structurally disallowed tools (--disallowedTools CLI flag) */
  disallowedTools?: string[];
  /** Optional callback for recording token usage */
  onTokenUsage?: (record: TokenUsageRecord) => void;
  /** Channel key for token usage tracking */
  channelKey?: string;
  /** Agent ID for token usage tracking */
  agentId?: string;
  /** Effort level for Claude 4.6 adaptive thinking */
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

export interface StreamMessage {
  type: 'system' | 'assistant' | 'result' | 'error' | 'user';
  subtype?: string;
  message?: {
    role: string;
    content: ContentBlock[];
    model?: string;
    id?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  error?: string;
}

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
  duration_ms?: number;
}

export interface PromptCallbacks {
  onDelta?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  onFinal?: (response: { content: string; toolUseBlocks: ToolUseBlock[] }) => void;
  onError?: (error: Error) => void;
}

type ProcessState = 'idle' | 'busy' | 'starting' | 'dead';

/**
 * PersistentClaudeProcess - Manages a single long-lived Claude CLI process
 *
 * Features:
 * - Keeps Claude process alive for multiple messages
 * - Uses stream-json for bidirectional communication
 * - Handles tool execution via Gateway Tools
 * - Auto-restarts on process death
 */
export class PersistentClaudeProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: PersistentProcessOptions;
  private state: ProcessState = 'dead';
  private outputBuffer: string = '';
  private currentCallbacks: PromptCallbacks | null = null;
  private currentResolve: ((result: PromptResult) => void) | null = null;
  private currentReject: ((error: Error) => void) | null = null;
  private requestTimeoutHandle: NodeJS.Timeout | null = null;
  private toolUseBlocks: ToolUseBlock[] = [];
  private accumulatedText: string = '';
  private startPromise: Promise<void> | null = null;
  private onTokenUsage?: (record: TokenUsageRecord) => void;

  constructor(options: PersistentProcessOptions) {
    super();
    this.options = options;
    this.onTokenUsage = options.onTokenUsage;

    // Register default error handler to prevent Node crash if no listeners attached
    this.on('error', (err) => {
      console.error('[PersistentCLI] Unhandled error event:', err);
    });
  }

  /**
   * Start the Claude CLI process
   *
   * Note: The CLI only emits the 'init' event after receiving the first user message.
   * So we don't wait for init here - we just start the process and let it run.
   * The first sendMessage() call will handle init as part of its response flow.
   */
  async start(): Promise<void> {
    // Serialize concurrent start() calls — if already starting, wait for that to finish
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.state !== 'dead') {
      persistentLogger.info(`[PersistentCLI] Process already in state: ${this.state}`);
      return;
    }

    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    this.state = 'starting';
    persistentLogger.info(
      `[PersistentCLI] Starting process for session: ${this.options.sessionId}`
    );

    const args = this.buildArgs();
    persistentLogger.info(`[PersistentCLI] Spawning: claude ${args.join(' ')}`);

    // Clean environment: Remove conflicting MAMA_* variables before merging
    const cleanEnv = { ...process.env };
    if (this.options.env) {
      // If we're setting MAMA_DISABLE_HOOKS, remove MAMA_HOOK_FEATURES
      if ('MAMA_DISABLE_HOOKS' in this.options.env) {
        delete cleanEnv.MAMA_HOOK_FEATURES;
      }
      // If we're setting MAMA_HOOK_FEATURES, remove MAMA_DISABLE_HOOKS
      if ('MAMA_HOOK_FEATURES' in this.options.env) {
        delete cleanEnv.MAMA_DISABLE_HOOKS;
      }
    }

    // Use home directory as cwd so agents have broad file access
    this.process = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: os.homedir(),
      env: { ...cleanEnv, ...(this.options.env || {}) },
    });

    // Set up event handlers
    this.process.stdout?.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr?.on('data', (chunk) => this.handleStderr(chunk));
    this.process.on('close', (code) => this.handleClose(code));
    this.process.on('error', (error) => this.handleError(error));

    // Don't wait for init - CLI only emits it after first user message
    // Just wait a brief moment for the process to stabilize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Guard: Only set idle if still in starting state AND process is alive
    // handleClose could have been called during the setTimeout above (→ state='dead')
    // Note: TS can't track async state mutations from event handlers, so cast is needed
    const currentState = this.state as ProcessState;
    const pid = this.process?.pid;
    if (currentState === 'starting' && pid && !this.process?.killed) {
      this.state = 'idle';
      persistentLogger.info(`[PersistentCLI] Process started and waiting for first message`);
    } else {
      this.state = 'dead';
      throw new Error('Process failed to start');
    }
  }

  /**
   * Build CLI arguments for stream-json mode
   */
  private buildArgs(): string[] {
    const args = [
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--session-id',
      this.options.sessionId,
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.systemPrompt) {
      args.push('--system-prompt', this.options.systemPrompt);
    }

    // Hybrid mode: MCP + Gateway can both be enabled
    if (this.options.mcpConfigPath) {
      args.push('--mcp-config', this.options.mcpConfigPath);
      args.push('--strict-mcp-config');
      persistentLogger.info('MCP enabled:', this.options.mcpConfigPath);
    }
    if (this.options.useGatewayTools) {
      persistentLogger.info('Gateway Tools mode enabled');
    }

    if (this.options.effort && supportsThinkingEffortModel(this.options.model)) {
      args.push(
        '--thinking-effort',
        normalizeThinkingEffort(this.options.model, this.options.effort)
      );
    }

    if (this.options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Structural tool enforcement via CLI flags
    if (this.options.allowedTools?.length) {
      args.push('--allowedTools', ...this.options.allowedTools);
    }
    if (this.options.disallowedTools?.length) {
      args.push('--disallowedTools', ...this.options.disallowedTools);
    }

    return args;
  }

  /**
   * Send a user message to Claude
   */
  async sendMessage(content: string, callbacks?: PromptCallbacks): Promise<PromptResult> {
    if (this.state === 'dead') {
      await this.start();
    }

    // If another caller is starting, wait for it to finish
    if (this.startPromise) {
      await this.startPromise;
    }

    // Prevent concurrent requests during active processing
    if (this.state === 'busy') {
      throw new Error('Process is busy with another request');
    }

    if (this.state === 'starting' || this.state === 'dead') {
      throw new Error(`Process is not ready (state: ${this.state})`);
    }

    this.state = 'busy';
    this.currentCallbacks = callbacks || null;
    this.toolUseBlocks = [];
    this.accumulatedText = '';

    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;

      // Set request timeout
      const timeoutMs = this.options.requestTimeout || 120000;
      this.requestTimeoutHandle = setTimeout(() => {
        this.handleTimeout();
      }, timeoutMs);

      // Strip lone surrogates to prevent API 400 errors
      const safeContent = content.replace(LONE_SURROGATE_RE, '');

      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: safeContent,
        },
      };

      const jsonLine = JSON.stringify(message) + '\n';
      persistentLogger.info(`[PersistentCLI] Sending message (${content.length} chars)`);

      if (!this.process?.stdin?.writable) {
        this.handleError(new Error('Process stdin not writable'));
        return;
      }

      this.process.stdin.write(jsonLine, (err) => {
        if (err) {
          this.handleError(err);
        }
      });
    });
  }

  /**
   * Send a tool result back to Claude
   */
  async sendToolResult(
    toolUseId: string,
    result: string,
    isError: boolean = false,
    callbacks?: PromptCallbacks
  ): Promise<PromptResult> {
    return this.sendToolResults(
      [{ tool_use_id: toolUseId, content: result, is_error: isError }],
      callbacks
    );
  }

  /**
   * Send multiple tool results back to Claude in a single message.
   * Required when Claude requests multiple tools in one turn.
   */
  async sendToolResults(
    results: Array<{ tool_use_id: string; content: string; is_error: boolean }>,
    callbacks?: PromptCallbacks
  ): Promise<PromptResult> {
    if (this.state === 'dead') {
      throw new Error('Cannot send tool result: process is dead');
    }

    if (this.state !== 'idle') {
      throw new Error(`Cannot send tool result in state: ${this.state}`);
    }

    this.state = 'busy';
    this.currentCallbacks = callbacks || null;
    this.toolUseBlocks = [];
    this.accumulatedText = '';

    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;

      // Set request timeout
      const timeoutMs = this.options.requestTimeout || 120000;
      this.requestTimeoutHandle = setTimeout(() => {
        this.handleTimeout();
      }, timeoutMs);

      // Strip lone surrogates from tool results to prevent API 400 errors
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.tool_use_id,
            content: r.content.replace(LONE_SURROGATE_RE, ''),
            is_error: r.is_error,
          })),
        },
      };

      const jsonLine = JSON.stringify(message) + '\n';
      persistentLogger.info(
        `[PersistentCLI] Sending ${results.length} tool_result(s): ${results.map((r) => r.tool_use_id).join(', ')}`
      );

      if (!this.process?.stdin?.writable) {
        this.handleError(new Error('Process stdin not writable'));
        return;
      }

      this.process.stdin.write(jsonLine, (err) => {
        if (err) {
          this.handleError(err);
        }
      });
    });
  }

  /**
   * Handle stdout data
   */
  private handleStdout(chunk: Buffer): void {
    this.outputBuffer += chunk.toString();

    // Process complete lines
    const lines = this.outputBuffer.split('\n');
    this.outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line) as StreamMessage;
        this.processEvent(event);
      } catch {
        console.warn(`[PersistentCLI] Failed to parse JSON: ${line.substring(0, 100)}...`);
      }
    }

    // Try to parse buffer as complete JSON (handles case where line doesn't end with newline)
    // This is needed because Claude CLI may not flush a trailing newline when waiting for stdin
    if (this.outputBuffer.trim()) {
      try {
        const event = JSON.parse(this.outputBuffer) as StreamMessage;
        this.processEvent(event);
        this.outputBuffer = ''; // Clear buffer after successful parse
      } catch {
        // Not complete JSON yet, wait for more data
      }
    }
  }

  /**
   * Process a parsed event from stdout
   */
  private processEvent(event: StreamMessage): void {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          persistentLogger.info(`[PersistentCLI] Received init event`);
          // Init event received (logged for debugging)
          this.emit('init', event);
        } else if (event.subtype === 'hook_response') {
          // Hook responses - could extract context if needed
          persistentLogger.info(`[PersistentCLI] Hook response received`);
        }
        break;

      case 'assistant':
        // Process assistant message content
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              this.accumulatedText += block.text || '';
              this.currentCallbacks?.onDelta?.(block.text || '');
            } else if (block.type === 'tool_use') {
              const toolName = block.name ?? 'unknown';
              const toolUse: ToolUseBlock = {
                type: 'tool_use',
                id: block.id || `tool_${randomUUID()}`,
                name: toolName,
                input: block.input || {},
              };
              this.toolUseBlocks.push(toolUse);
              this.currentCallbacks?.onToolUse?.(toolName, block.input ?? {});
              persistentLogger.info(`[PersistentCLI] Tool use: ${toolName}`);
            }
          }
        }
        break;

      case 'result':
        // Request complete
        this.clearRequestTimeout();

        if (event.subtype === 'success') {
          const result: PromptResult = {
            response: event.result || this.accumulatedText,
            session_id: event.session_id || this.options.sessionId,
            cost_usd: event.total_cost_usd,
            duration_ms: event.duration_ms,
            usage: {
              input_tokens: event.usage?.input_tokens || 0,
              output_tokens: event.usage?.output_tokens || 0,
              cache_creation_input_tokens: event.usage?.cache_creation_input_tokens,
              cache_read_input_tokens: event.usage?.cache_read_input_tokens,
            },
            toolUseBlocks: this.toolUseBlocks.length > 0 ? this.toolUseBlocks : undefined,
            hasToolUse: this.toolUseBlocks.length > 0,
          };

          // Record token usage
          if (this.onTokenUsage) {
            try {
              this.onTokenUsage({
                channel_key: this.options.channelKey || 'cli',
                agent_id: this.options.agentId || undefined,
                input_tokens: event.usage?.input_tokens || 0,
                output_tokens: event.usage?.output_tokens || 0,
                cache_read_tokens: event.usage?.cache_read_input_tokens || 0,
                cost_usd: event.total_cost_usd || undefined,
              });
            } catch {
              /* ignore recording errors */
            }
          }

          persistentLogger.info(
            `[PersistentCLI] Request complete (${event.duration_ms}ms, ${this.toolUseBlocks.length} tools)`
          );
          this.currentCallbacks?.onFinal?.({
            content: result.response,
            toolUseBlocks: this.toolUseBlocks,
          });
          this.state = 'idle';
          this.currentResolve?.(result);
          this.resetRequestState();
          this.emit('idle'); // F7: Trigger message queue drain (after resolve/cleanup)
        } else if (event.is_error) {
          const error = new Error(event.error || 'Unknown error');
          this.currentCallbacks?.onError?.(error);
          this.state = 'idle';
          this.currentReject?.(error);
          this.resetRequestState();
          this.emit('idle'); // F7: Trigger message queue drain (after reject/cleanup)
        }
        break;

      case 'error': {
        this.clearRequestTimeout();
        const error = new Error(event.error || 'Unknown error');
        this.currentCallbacks?.onError?.(error);
        this.state = 'idle';
        this.currentReject?.(error);
        this.resetRequestState();
        this.emit('idle'); // F7: Trigger message queue drain (after reject/cleanup)
        break;
      }
    }
  }

  /**
   * Handle stderr data
   */
  private handleStderr(chunk: Buffer): void {
    const text = chunk.toString().trim();
    if (text) {
      console.error(`[PersistentCLI:stderr] ${text}`);
    }
  }

  /**
   * Handle process close
   */
  private handleClose(code: number | null): void {
    persistentLogger.info(`[PersistentCLI] Process closed with code ${code}`);
    this.state = 'dead';
    this.process = null;

    // Reject any pending request
    if (this.currentReject) {
      this.currentReject(new Error(`Process exited with code ${code}`));
      this.resetRequestState();
    }

    this.emit('close', code);
  }

  /**
   * Handle process error
   */
  private handleError(error: Error): void {
    console.error(`[PersistentCLI] Process error:`, error.message);

    if (this.currentReject) {
      this.currentReject(error);
      this.resetRequestState();
    }

    // Transition to idle so subsequent requests aren't blocked
    if (this.state === 'busy') {
      this.state = 'idle';
      this.emit('idle');
    }

    this.emit('error', error);
  }

  /**
   * Handle request timeout
   */
  private handleTimeout(): void {
    console.error(`[PersistentCLI] Request timeout`);

    if (this.currentReject) {
      this.currentReject(new Error('Request timeout'));
      this.resetRequestState();
    }

    this.state = 'idle';
    this.emit('idle'); // F7: Trigger message queue drain (after cleanup)
  }

  /**
   * Clear request timeout
   */
  private clearRequestTimeout(): void {
    if (this.requestTimeoutHandle) {
      clearTimeout(this.requestTimeoutHandle);
      this.requestTimeoutHandle = null;
    }
  }

  /**
   * Reset request state
   */
  private resetRequestState(): void {
    this.clearRequestTimeout();
    this.currentCallbacks = null;
    this.currentResolve = null;
    this.currentReject = null;
    this.toolUseBlocks = [];
    this.accumulatedText = '';
  }

  /**
   * Stop the process
   */
  stop(): void {
    persistentLogger.info(`[PersistentCLI] Stopping process`);

    // Reject any pending request BEFORE resetting state
    // This ensures promises are resolved even if process is already dead
    if (this.currentReject) {
      this.currentReject(new Error('Process stopped by user'));
    }

    if (this.process) {
      this.clearRequestTimeout();
      this.process.stdin?.end();
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.state = 'dead';
    this.resetRequestState();
  }

  /**
   * Check if process is alive
   */
  isAlive(): boolean {
    return this.state !== 'dead';
  }

  /**
   * Check if process is ready for new messages
   */
  isReady(): boolean {
    return this.state === 'idle';
  }

  /**
   * Get current state
   */
  getState(): ProcessState {
    return this.state;
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.options.sessionId;
  }
}

/**
 * PersistentProcessPool - Manages multiple persistent Claude processes
 *
 * Features:
 * - One process per channel/session
 * - Automatic process lifecycle management
 * - Process reuse for multi-turn conversations
 */
export class PersistentProcessPool {
  private processes: Map<string, PersistentClaudeProcess> = new Map();
  private defaultOptions: Partial<PersistentProcessOptions>;

  constructor(defaultOptions: Partial<PersistentProcessOptions> = {}) {
    this.defaultOptions = defaultOptions;
  }

  /**
   * Get or create a process for a channel
   */
  async getProcess(
    channelKey: string,
    options?: Partial<PersistentProcessOptions>
  ): Promise<PersistentClaudeProcess> {
    let process = this.processes.get(channelKey);

    if (!process || !process.isAlive()) {
      // Create new process
      const mergedOptions: PersistentProcessOptions = {
        sessionId: randomUUID(),
        ...this.defaultOptions,
        ...options,
      };

      poolLogger.info(`Creating new process for channel: ${channelKey}`);
      process = new PersistentClaudeProcess(mergedOptions);

      // Handle process errors - prevent unhandled 'error' event crash
      process.on('error', (err) => {
        poolLogger.error(`Process error for ${channelKey}:`, err);
        this.processes.delete(channelKey);
      });

      // Handle process death - remove from pool
      process.on('close', () => {
        poolLogger.info(`Process for ${channelKey} closed, removing from pool`);
        this.processes.delete(channelKey);
      });

      this.processes.set(channelKey, process);
      await process.start();
    }

    return process;
  }

  /**
   * Stop a specific process
   */
  stopProcess(channelKey: string): void {
    const process = this.processes.get(channelKey);
    if (process) {
      process.stop();
      this.processes.delete(channelKey);
    }
  }

  /**
   * Stop all processes
   */
  stopAll(): void {
    for (const [key, process] of this.processes) {
      poolLogger.info(`Stopping process for: ${key}`);
      process.stop();
    }
    this.processes.clear();
  }

  /**
   * Get number of active processes
   */
  getActiveCount(): number {
    return this.processes.size;
  }

  /**
   * Get all channel keys with active processes
   */
  getActiveChannels(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Get states of all active processes
   * @returns Map of channelKey → ProcessState
   */
  getProcessStates(): Map<string, string> {
    const states = new Map<string, string>();
    for (const [key, proc] of this.processes) {
      states.set(key, proc.getState());
    }
    return states;
  }
}
