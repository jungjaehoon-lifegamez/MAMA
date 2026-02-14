/**
 * Codex App Server Process - Persistent Codex CLI via app-server protocol
 *
 * WHY THIS EXISTS:
 * - Previous CodexCLIWrapper spawned new `codex exec` for each message
 * - Each spawn with `resume` reloads entire conversation history (20K+ tokens/message)
 * - Result: Context explodes after ~10 messages (200K limit)
 *
 * NEW ARCHITECTURE:
 * - Keep `codex app-server` process alive using JSON-RPC over stdio
 * - Send messages via stdin, receive events via stdout
 * - Session memory preserved in server process
 * - Manual compaction available via ThreadCompactStart
 *
 * PROTOCOL (JSON-RPC 2.0):
 * Request:  {"jsonrpc":"2.0","id":1,"method":"thread/start","params":{...}}
 * Response: {"jsonrpc":"2.0","id":1,"result":{...}}
 * Event:    {"jsonrpc":"2.0","method":"turn.completed","params":{...}}
 */

import { spawn, ChildProcess } from 'child_process';
import os from 'os';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('CodexAppServer');

// ============================================================================
// Types
// ============================================================================

export interface CodexAppServerOptions {
  /** Model to use (e.g., 'gpt-5.2-codex') */
  model?: string;
  /** Working directory for Codex */
  cwd?: string;
  /** Sandbox mode */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Approval policy */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  /** System/developer instructions */
  systemPrompt?: string;
  /** Timeout for each request in ms (default: 120000) */
  timeoutMs?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Context compaction threshold (tokens, default: 160000) */
  compactionThreshold?: number;
}

export interface PromptResult {
  response: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  };
  session_id: string;
  cost_usd?: number;
}

export interface PromptCallbacks {
  onDelta?: (text: string) => void;
  onFinal?: (response: { response: string }) => void;
  onError?: (error: Error) => void;
}

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// Thread/Turn types (matching Codex app-server schema)
interface ThreadStartResponse {
  thread: { id: string };
  model: string;
}

interface TurnCompleteEvent {
  threadId: string;
  turn: {
    id: string;
    status: string;
  };
}

interface TokenCountEvent {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

type ProcessState = 'idle' | 'busy' | 'starting' | 'dead';

// ============================================================================
// CodexAppServerProcess
// ============================================================================

export class CodexAppServerProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: CodexAppServerOptions;
  private state: ProcessState = 'dead';
  private threadId: string | null = null;
  private requestId = 0;
  private pendingRequests: Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  // Current turn state
  private currentResolve: ((result: PromptResult) => void) | null = null;
  private currentReject: ((error: Error) => void) | null = null;
  private currentCallbacks: PromptCallbacks | null = null;
  private accumulatedResponse = '';
  private lastUsage: TokenCountEvent | null = null;

  // Context tracking
  private totalInputTokens = 0;
  private compactionThreshold: number;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    this.options = options;
    this.compactionThreshold = options.compactionThreshold ?? 160000;

    this.on('error', (err) => {
      logger.error('Unhandled error:', err);
    });
  }

  /**
   * Start the Codex app-server process
   */
  async start(): Promise<void> {
    if (this.state !== 'dead') {
      logger.info(`Process already in state: ${this.state}`);
      return;
    }

    this.state = 'starting';
    logger.info('Starting Codex app-server process');

    const args = ['app-server', '--listen', 'stdio://'];

    this.process = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd ?? os.homedir(),
      env: { ...process.env, ...this.options.env },
    });

    // Set up readline for line-based JSON parsing
    const rl = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => this.handleLine(line));

    this.process.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.warn('stderr:', text);
      }
    });

    this.process.on('close', (code) => this.handleClose(code));
    this.process.on('error', (error) => this.handleError(error));

    // Wait for process to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Initialize the app-server (required handshake)
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'MAMA',
        version: '1.0.0',
      },
    });
    logger.info('Codex app-server initialized');

    this.state = 'idle';
    logger.info('Codex app-server started');
  }

  /**
   * Send a prompt and get response
   */
  async prompt(
    content: string,
    callbacks?: PromptCallbacks,
    options?: { model?: string; resumeSession?: boolean }
  ): Promise<PromptResult> {
    // Note: resumeSession is ignored - app-server always maintains session
    if (options?.model) {
      this.options.model = options.model;
    }
    // Ensure process is running
    if (this.state === 'dead') {
      await this.start();
    }

    // Wait if busy
    while (this.state === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.state = 'busy';
    this.currentCallbacks = callbacks ?? null;
    this.accumulatedResponse = '';
    this.lastUsage = null;

    try {
      // Start thread if needed
      if (!this.threadId) {
        await this.startThread();
      }

      // Check for compaction need
      if (this.totalInputTokens >= this.compactionThreshold) {
        logger.info(`Context at ${this.totalInputTokens} tokens, triggering compaction`);
        await this.compactThread();
      }

      // Send turn
      const result = await this.sendTurn(content);

      // Update token tracking
      if (this.lastUsage !== null) {
        this.totalInputTokens = (this.lastUsage as TokenCountEvent).input_tokens;
      }

      return result;
    } finally {
      this.state = 'idle';
      this.currentCallbacks = null;
      this.currentResolve = null;
      this.currentReject = null;
    }
  }

  /**
   * Start a new thread
   */
  private async startThread(): Promise<void> {
    const params: Record<string, unknown> = {
      experimentalRawEvents: false,
    };

    if (this.options.model) {
      params.model = this.options.model;
    }
    if (this.options.cwd) {
      params.cwd = this.options.cwd;
    }
    if (this.options.approvalPolicy) {
      params.approvalPolicy = this.options.approvalPolicy;
    }
    if (this.options.sandbox) {
      params.sandbox = this.mapSandboxMode(this.options.sandbox);
    }
    if (this.options.systemPrompt) {
      params.developerInstructions = this.options.systemPrompt;
    }

    const response = (await this.sendRequest('thread/start', params)) as ThreadStartResponse;
    this.threadId = response.thread.id;
    this.totalInputTokens = 0;
    logger.info(`Thread started: ${this.threadId}, model: ${response.model}`);
  }

  /**
   * Send a turn (message) to the thread
   */
  private sendTurn(content: string): Promise<PromptResult> {
    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;

      const params = {
        threadId: this.threadId,
        input: [{ type: 'text', text: content, text_elements: [] }],
      };

      if (this.options.approvalPolicy) {
        (params as Record<string, unknown>).approvalPolicy = this.options.approvalPolicy;
      }

      // Set timeout
      const timeout = setTimeout(() => {
        this.currentReject?.(new Error(`Turn timeout after ${this.options.timeoutMs ?? 120000}ms`));
      }, this.options.timeoutMs ?? 120000);

      // Send request (don't await - we handle completion via events)
      this.sendRequest('turn/start', params)
        .then(() => {
          // Request sent, now wait for turn.completed event
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });

      // Store timeout handle for cleanup
      (this as unknown as { _turnTimeout: NodeJS.Timeout })._turnTimeout = timeout;
    });
  }

  /**
   * Compact the thread to reduce context size
   */
  private async compactThread(): Promise<void> {
    if (!this.threadId) return;

    logger.info(`Compacting thread ${this.threadId}`);
    await this.sendRequest('thread/compact/start', { threadId: this.threadId });

    // Wait for compaction to complete (via event)
    await new Promise<void>((resolve) => {
      const handler = () => {
        this.off('context.compacted', handler);
        resolve();
      };
      this.on('context.compacted', handler);
      // Timeout after 30s
      setTimeout(() => {
        this.off('context.compacted', handler);
        resolve();
      }, 30000);
    });

    logger.info('Thread compaction completed');
  }

  /**
   * Reset the session (start new thread)
   */
  async resetSession(): Promise<void> {
    this.threadId = null;
    this.totalInputTokens = 0;
    logger.info('Session reset, will start new thread on next prompt');
  }

  /**
   * Get current session ID (thread ID)
   */
  getSessionId(): string {
    return this.threadId ?? '';
  }

  /**
   * Set session ID (for compatibility with CodexCLIWrapper)
   * Note: This doesn't actually resume a thread - use resetSession() for that
   */
  setSessionId(sessionId: string): void {
    // In app-server mode, we don't support resuming arbitrary session IDs
    // This is for compatibility only - the thread is managed internally
    logger.debug(
      `setSessionId called with ${sessionId}, but app-server manages threads internally`
    );
  }

  /**
   * Set system prompt (for compatibility with CodexCLIWrapper)
   */
  setSystemPrompt(prompt: string): void {
    this.options.systemPrompt = prompt;
  }

  /**
   * Get current token usage
   */
  getTokenUsage(): number {
    return this.totalInputTokens;
  }

  /**
   * Stop the process
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.state = 'dead';
    this.threadId = null;
    this.pendingRequests.clear();
    logger.info('Process stopped');
  }

  // ============================================================================
  // Internal methods
  // ============================================================================

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error('Process not running');
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const line = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(line);
      logger.debug(`Sent: ${method} (id=${id})`);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;

      if ('id' in msg && msg.id !== undefined) {
        // Response to a request
        this.handleResponse(msg as JsonRpcResponse);
      } else if ('method' in msg) {
        // Server notification/event
        this.handleNotification(msg as JsonRpcNotification);
      }
    } catch {
      logger.warn('Failed to parse line:', line.substring(0, 100));
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn(`Unexpected response id: ${response.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const method = notification.method;
    const params = notification.params ?? {};

    logger.debug(`Event: ${method}`);

    switch (method) {
      case 'turn/completed':
        this.handleTurnCompleted(params as unknown as TurnCompleteEvent);
        break;

      case 'thread/tokenUsage/updated':
        // Extract token usage from the event
        if (params.tokenUsage && typeof params.tokenUsage === 'object') {
          const usage = params.tokenUsage as {
            total?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
          };
          if (usage.total) {
            this.lastUsage = {
              input_tokens: usage.total.inputTokens ?? 0,
              output_tokens: usage.total.outputTokens ?? 0,
              cached_input_tokens: usage.total.cachedInputTokens ?? 0,
              total_tokens: (usage.total.inputTokens ?? 0) + (usage.total.outputTokens ?? 0),
            };
          }
        }
        break;

      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          this.accumulatedResponse += params.delta;
          this.currentCallbacks?.onDelta?.(params.delta as string);
        }
        break;

      case 'context/compacted':
        this.totalInputTokens = 0; // Reset after compaction
        this.emit('context.compacted');
        break;

      case 'turn/started':
        logger.debug(`Turn started`);
        break;

      case 'codex/event/task_complete':
        // Task complete has the final message
        if (params.msg && typeof params.msg === 'object') {
          const msg = params.msg as { last_agent_message?: string };
          if (msg.last_agent_message) {
            this.accumulatedResponse = msg.last_agent_message;
          }
        }
        break;

      case 'codex/event/error':
      case 'error':
        logger.error('Server error:', params);
        this.currentReject?.(new Error(String(params.message ?? 'Unknown error')));
        break;

      default:
        // Ignore other events (mcp_startup_*, item/started, item/completed, etc.)
        break;
    }
  }

  private handleTurnCompleted(_event: TurnCompleteEvent): void {
    // Clear timeout
    const timeout = (this as unknown as { _turnTimeout?: NodeJS.Timeout })._turnTimeout;
    if (timeout) {
      clearTimeout(timeout);
    }

    // Use accumulated response (from delta events or task_complete)
    const response = this.accumulatedResponse;

    this.currentCallbacks?.onFinal?.({ response });

    this.currentResolve?.({
      response,
      usage: {
        input_tokens: this.lastUsage?.input_tokens ?? 0,
        output_tokens: this.lastUsage?.output_tokens ?? 0,
        cached_input_tokens: this.lastUsage?.cached_input_tokens,
      },
      session_id: this.threadId ?? '',
    });
  }

  private handleClose(code: number | null): void {
    logger.info(`Process closed with code ${code}`);
    this.state = 'dead';
    this.process = null;
    this.threadId = null;

    // Reject any pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Process closed'));
    }
    this.pendingRequests.clear();
  }

  private handleError(error: Error): void {
    logger.error('Process error:', error);
    this.emit('error', error);
  }

  private mapSandboxMode(mode: string): string {
    // app-server expects string values: 'read-only', 'workspace-write', 'danger-full-access'
    return mode;
  }
}

// ============================================================================
// Process Pool (for multi-channel support)
// ============================================================================

/**
 * Pool of CodexAppServerProcess instances, one per channel
 */
export class CodexAppServerPool {
  private processes: Map<string, CodexAppServerProcess> = new Map();
  private options: CodexAppServerOptions;

  constructor(options: CodexAppServerOptions = {}) {
    this.options = options;
  }

  /**
   * Get or create a process for a channel
   */
  async getProcess(channelKey: string): Promise<CodexAppServerProcess> {
    let process = this.processes.get(channelKey);

    if (!process) {
      process = new CodexAppServerProcess(this.options);
      this.processes.set(channelKey, process);
      await process.start();
    }

    return process;
  }

  /**
   * Reset a channel's session
   */
  async resetSession(channelKey: string): Promise<void> {
    const process = this.processes.get(channelKey);
    if (process) {
      await process.resetSession();
    }
  }

  /**
   * Stop all processes
   */
  stopAll(): void {
    for (const process of this.processes.values()) {
      process.stop();
    }
    this.processes.clear();
  }

  /**
   * Get active process count
   */
  getActiveCount(): number {
    return this.processes.size;
  }
}
