/**
 * Codex MCP Process - Codex via MCP protocol
 *
 * Architecture:
 *   채팅 → MCP Client → codex mcp-server → MCP → 채팅
 *
 * Uses standard MCP protocol instead of app-server's JSON-RPC.
 * Benefits:
 * - Standard MCP protocol
 * - compact-prompt parameter for compaction control
 * - threadId-based session management
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import { accessSync, constants } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('CodexMCP');
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 60 * 1000;

export interface CodexMCPOptions {
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  systemPrompt?: string;
  compactPrompt?: string;
  timeoutMs?: number;
  command?: string;
}

export interface PromptCallbacks {
  onDelta?: (text: string) => void;
  onFinal?: (response: { response: string }) => void;
  onError?: (error: Error) => void;
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
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timeout: NodeJS.Timeout;
}

export class CodexMCPProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: CodexMCPOptions;
  private state: 'dead' | 'starting' | 'ready' | 'busy' = 'dead';
  private threadId: string | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private rl: readline.Interface | null = null;

  constructor(options: CodexMCPOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * Start the Codex MCP server process
   */
  async start(): Promise<void> {
    if (this.state !== 'dead') {
      logger.info(`Process already in state: ${this.state}`);
      return;
    }

    this.state = 'starting';
    let command: string;
    try {
      command = this.resolveCodexCommand();
    } catch (error) {
      this.state = 'dead';
      throw error;
    }
    logger.info(`Starting Codex MCP server with command: ${command}`);

    try {
      this.process = spawn(command, ['mcp-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.options.cwd,
      });
    } catch (error) {
      const startError = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to start Codex MCP process:', startError);
      this.state = 'dead';
      this.process = null;
      throw startError;
    }

    if (!this.process) {
      const startError = new Error(`Failed to create Codex MCP process with command: ${command}`);
      this.state = 'dead';
      throw startError;
    }

    // Set up readline for JSON parsing
    this.rl = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => this.handleLine(line));

    this.process.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.warn('stderr:', text);
      }
    });

    this.process.on('close', (code) => {
      logger.info(`Process closed with code ${code}`);
      this.shutdown(new Error(`Process closed with code ${code ?? 'unknown'}`), false);
    });

    // Wait for process to either start successfully or fail with spawn error
    await new Promise<void>((resolve, reject) => {
      const onSpawnError = (error: Error): void => {
        logger.error('Process spawn error:', error);
        this.state = 'dead';
        reject(error);
      };
      this.process!.on('error', onSpawnError);

      // Give process a moment to start; if no error fires, it spawned OK
      setTimeout(() => {
        this.process?.removeListener('error', onSpawnError);
        this.process?.on('error', (error) => {
          logger.error('Process error:', error);
          if (this.listenerCount('error') > 0) {
            this.emit('error', error);
          }
          this.shutdown(error instanceof Error ? error : new Error(String(error)), true);
        });
        resolve();
      }, 200);
    });

    try {
      // MCP Initialize (bounded timeout to avoid dead startup)
      await Promise.race([
        this.sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'MAMA', version: '1.0.0' },
        }),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`MCP initialize timeout after ${DEFAULT_INITIALIZE_TIMEOUT_MS}ms`));
          }, DEFAULT_INITIALIZE_TIMEOUT_MS);
        }),
      ]);

      this.state = 'ready';
      logger.info('Codex MCP server ready');
    } catch (error) {
      logger.error('MCP initialization failed:', error);
      this.cleanup('MCP initialization failed');
      throw error;
    }
  }

  /**
   * Send a prompt and get response
   */
  async prompt(
    content: string,
    callbacks?: PromptCallbacks,
    options?: { model?: string; resumeSession?: boolean }
  ): Promise<PromptResult> {
    // Ensure process is running (retry once on failure)
    if (this.state === 'dead') {
      try {
        await this.start();
      } catch (err) {
        logger.warn('First start attempt failed, retrying in 1s:', err);
        this.cleanup('Process restart after failed start');
        await new Promise((r) => setTimeout(r, 1000));
        await this.start();
      }
    }

    // Handle resumeSession option
    if (options?.resumeSession === false) {
      this.threadId = null;
    }

    // Override model if provided
    const effectiveModel = options?.model || this.options.model;

    // Wait if not ready (with timeout)
    const maxWaitMs = this.options.timeoutMs ?? 120000;
    const waitStart = Date.now();
    while (this.state !== 'ready') {
      if (this.state === 'dead') {
        throw new Error('Process is not running');
      }
      if (Date.now() - waitStart > maxWaitMs) {
        throw new Error('Timed out waiting for process to be ready');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.state = 'busy';

    try {
      let result: {
        threadId: string;
        content: string;
        usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
      };

      if (!this.threadId) {
        // First message: use "codex" tool
        const args: Record<string, unknown> = {
          prompt: content,
        };

        if (effectiveModel) {
          args.model = effectiveModel;
        }
        if (this.options.cwd) {
          args.cwd = this.options.cwd;
        }
        if (this.options.sandbox) {
          args.sandbox = this.options.sandbox;
        }
        if (this.options.systemPrompt) {
          args['developer-instructions'] = this.options.systemPrompt;
        }
        if (this.options.compactPrompt) {
          args['compact-prompt'] = this.options.compactPrompt;
        }

        result = await this.callToolWithRetry('codex', args);
        this.threadId = result.threadId;
        logger.info(`Thread started: ${this.threadId}`);
      } else {
        // Subsequent messages: use "codex-reply" tool
        result = await this.callToolWithRetry('codex-reply', {
          threadId: this.threadId,
          prompt: content,
        });
      }

      const response = result.content || '';
      callbacks?.onFinal?.({ response });

      return {
        response,
        usage: {
          input_tokens: result.usage?.inputTokens ?? 0,
          output_tokens: result.usage?.outputTokens ?? 0,
          cached_input_tokens: result.usage?.cachedTokens ?? 0,
        },
        session_id: this.threadId || '',
      };
    } finally {
      // Only reset to ready if process is still alive (not crashed)
      // Note: close handler may have set state to 'dead' asynchronously
      if (this.process !== null && (this.state as string) !== 'dead') {
        this.state = 'ready';
      }
    }
  }

  /**
   * Reset the session
   */
  async resetSession(): Promise<void> {
    this.threadId = null;
    logger.info('Session reset');
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.threadId ?? '';
  }

  /**
   * Set session ID (for compatibility)
   * Note: CodexMCPProcess manages its own threadId from Codex responses.
   * External session IDs are ignored to prevent conflicts.
   */
  setSessionId(_sessionId: string): void {
    // Ignore external session IDs - Codex MCP manages threadId internally
    // The threadId is set only from Codex 'codex' tool response
    logger.debug(`setSessionId called but ignored (MCP manages threadId internally)`);
  }

  /**
   * Set system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.options.systemPrompt = prompt;
  }

  /**
   * Stop the process
   */
  stop(): void {
    this.cleanup('Process stopped');
    logger.info('Process stopped');
  }

  private cleanup(reason = 'Process terminated'): void {
    this.shutdown(new Error(reason), true);
  }

  // ============================================================================
  // Internal methods
  // ============================================================================

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    threadId: string;
    content: string;
    usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
  }> {
    const response = (await this.sendRequest('tools/call', {
      name,
      arguments: args,
    })) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: { threadId?: string; content?: string };
      _meta?: { usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } };
    };

    // Log full response structure for debugging
    const keys = Object.keys(response);
    logger.debug(`[RESPONSE_KEYS] ${keys.join(', ')}`);

    // Extract token usage if available
    const usage = response._meta?.usage;
    if (usage) {
      logger.debug(
        `[TOKENS] input: ${usage.inputTokens}, cached: ${usage.cachedTokens || 0}, output: ${usage.outputTokens}`
      );
    }

    // Check structuredContent first (preferred - has threadId)
    if (response.structuredContent?.threadId) {
      return {
        threadId: response.structuredContent.threadId,
        content: response.structuredContent.content || '',
        usage,
      };
    }

    // Fallback: Extract from content array
    if (response.content && Array.isArray(response.content)) {
      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent?.text) {
        try {
          const parsed = JSON.parse(textContent.text) as { threadId?: string; content?: string };
          return {
            threadId: parsed.threadId || this.threadId || '',
            content: parsed.content || textContent.text,
            usage,
          };
        } catch {
          return { content: textContent.text, threadId: this.threadId || '', usage };
        }
      }
    }

    // Defensive fallback for unexpected response format
    logger.warn(`Unexpected callTool response format: ${JSON.stringify(response)}`);
    return { threadId: this.threadId || '', content: '', usage };
  }

  private async callToolWithRetry(
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    threadId: string;
    content: string;
    usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
  }> {
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      try {
        logger.debug(`[CALL] ${name} (attempt=${attempt})`);
        return await this.callTool(name, args);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (attempt >= 2 || !this.isRetryableToolError(err)) {
          logger.error(`Call failed: ${name} (attempt=${attempt})`, err);
          throw err;
        }

        logger.warn(`Retrying ${name} after recoverable tool error: ${err.message}`);
        this.threadId = null;
        this.cleanup();
        await this.start();
      }
    }

    throw new Error(`Tool call failed after ${attempt} attempts: ${name}`);
  }

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
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        const timeoutError = new Error(
          `Request timeout: ${method} (id=${id}, timeoutMs=${timeoutMs})`
        );
        this.failPendingRequest(id, timeoutError);
        this.shutdown(timeoutError, true);
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, method, timeout });

      const line = JSON.stringify(request) + '\n';
      try {
        this.process!.stdin!.write(line);
        logger.debug(`Sent: ${method} (id=${id})`);
      } catch (error) {
        const requestError = error instanceof Error ? error : new Error(String(error));
        logger.error('Failed to write MCP request:', requestError);
        this.failPendingRequest(id, requestError);
        this.shutdown(requestError, true);
        reject(requestError);
      }
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line) as JsonRpcResponse;

      if ('id' in msg && msg.id !== undefined) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.id);

          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      logger.warn('Failed to parse line:', line.substring(0, 100));
    }
  }

  private resolveCodexCommand(): string {
    const configured = [
      this.options.command,
      process.env.MAMA_CODEX_COMMAND,
      process.env.CODEX_COMMAND,
    ];

    for (const candidate of configured) {
      if (!candidate) {
        continue;
      }
      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }
      if (this.isExecutable(trimmed)) {
        return trimmed;
      }
    }

    const fromPath = this.findExecutableInPath('codex');
    if (fromPath) {
      return fromPath;
    }

    const home = homedir();
    const fallbackCandidates = [
      join(home, '.local', 'bin', 'codex'),
      join(home, 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
      '/opt/homebrew/bin/codex',
      '/bin/codex',
    ];
    for (const candidate of fallbackCandidates) {
      if (this.isExecutable(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      'Codex command not found. Set MAMA_CODEX_COMMAND or CODEX_COMMAND to an executable path, or install codex in PATH.'
    );
  }

  private isExecutable(target: string): boolean {
    try {
      accessSync(target, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private findExecutableInPath(commandName: string): string | null {
    const pathValue = process.env.PATH || '';
    if (!pathValue) {
      return null;
    }

    const pathEntries = pathValue
      .split(delimiter)
      .map((value) => value.trim())
      .filter(Boolean);
    for (const dir of pathEntries) {
      const candidate = join(dir, commandName);
      if (this.isExecutable(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private failPendingRequest(id: number, error: Error): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);
    pending.reject(error);
  }

  private clearPendingRequests(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${error.message} (${pending.method})`));
    }
    this.pendingRequests.clear();
  }

  private isRetryableToolError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('request timeout') ||
      message.includes('process is not running') ||
      message.includes('process closed with code') ||
      message.includes('mcp initialize timeout') ||
      message.includes('connection closed') ||
      message.includes('econnreset')
    );
  }

  private shutdown(error: Error, shouldKillProcess: boolean): void {
    if (this.state === 'dead' && this.pendingRequests.size === 0 && !shouldKillProcess) {
      return;
    }

    this.state = 'dead';
    this.clearPendingRequests(error);
    if (shouldKillProcess && this.process) {
      this.process.kill();
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.process = null;
    this.threadId = null;
  }
}
