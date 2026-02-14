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

export interface CodexMCPOptions {
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  systemPrompt?: string;
  compactPrompt?: string;
  timeoutMs?: number;
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
    logger.info('Starting Codex MCP server');

    this.process = spawn('codex', ['mcp-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
    });

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
      this.state = 'dead';
      this.process = null;
      this.threadId = null;
    });

    this.process.on('error', (error) => {
      logger.error('Process error:', error);
      this.emit('error', error);
    });

    // Wait for process to start
    await new Promise((resolve) => setTimeout(resolve, 300));

    // MCP Initialize
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'MAMA', version: '1.0.0' },
    });

    this.state = 'ready';
    logger.info('Codex MCP server ready');
  }

  /**
   * Send a prompt and get response
   */
  async prompt(content: string, callbacks?: PromptCallbacks): Promise<PromptResult> {
    // Ensure process is running
    if (this.state === 'dead') {
      await this.start();
    }

    // Wait if busy
    while (this.state === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.state = 'busy';

    try {
      let result: { threadId: string; content: string };

      if (!this.threadId) {
        // First message: use "codex" tool
        const args: Record<string, unknown> = {
          prompt: content,
        };

        if (this.options.model) {
          args.model = this.options.model;
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

        result = (await this.callTool('codex', args)) as {
          threadId: string;
          content: string;
        };
        this.threadId = result.threadId;
        logger.info(`Thread started: ${this.threadId}`);
      } else {
        // Subsequent messages: use "codex-reply" tool
        result = (await this.callTool('codex-reply', {
          threadId: this.threadId,
          prompt: content,
        })) as { threadId: string; content: string };
      }

      const response = result.content || '';
      callbacks?.onFinal?.({ response });

      return {
        response,
        usage: {
          input_tokens: 0, // MCP doesn't provide token usage in response
          output_tokens: 0,
        },
        session_id: this.threadId || '',
      };
    } finally {
      this.state = 'ready';
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
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.state = 'dead';
    this.threadId = null;
    this.pendingRequests.clear();
    logger.info('Process stopped');
  }

  // ============================================================================
  // Internal methods
  // ============================================================================

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    logger.debug(`[CALL] ${name}`);

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
    logger.error(`[RESPONSE_KEYS] ${keys.join(', ')}`);

    // Log token usage if available
    if (response._meta?.usage) {
      const u = response._meta.usage;
      logger.error(
        `[TOKENS] input: ${u.inputTokens}, cached: ${u.cachedTokens || 0}, output: ${u.outputTokens}`
      );
    }

    // Check structuredContent first (preferred - has threadId)
    if (response.structuredContent?.threadId) {
      return {
        threadId: response.structuredContent.threadId,
        content: response.structuredContent.content || '',
      };
    }

    // Fallback: Extract from content array
    if (response.content && Array.isArray(response.content)) {
      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return { content: textContent.text, threadId: this.threadId };
        }
      }
    }

    return response;
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
      const timeoutMs = this.options.timeoutMs ?? 120000;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const line = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(line);
      logger.debug(`Sent: ${method} (id=${id})`);
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
}
