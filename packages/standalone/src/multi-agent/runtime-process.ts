import { EventEmitter } from 'events';
import {
  CodexMCPProcess,
  type CodexMCPOptions,
  type PromptCallbacks as CodexPromptCallbacks,
} from '../agent/codex-mcp-process.js';
import type {
  PromptCallbacks as ClaudePromptCallbacks,
  PromptResult as ClaudePromptResult,
} from '../agent/persistent-cli-process.js';
import type { IModelRunner, RunnerMetrics, PromptOptions } from '../agent/model-runner.js';

export interface AgentRuntimeProcess {
  sendMessage(content: string, callbacks?: ClaudePromptCallbacks): Promise<ClaudePromptResult>;
  isReady(): boolean;
  stop(): void;
  getSessionId?(): string;
  on(event: 'idle' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
}

export interface CodexRuntimeProcessOptions {
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  requestTimeout?: number;
  codexHome?: string;
  command?: string;
  // Legacy options (from old CLI approach - some may not be supported in MCP mode)
  profile?: string;
  ephemeral?: boolean;
  addDirs?: string[];
  configOverrides?: string[];
  skipGitRepoCheck?: boolean;
}

/**
 * Session-persistent Codex wrapper with the same minimal contract used by
 * multi-agent runtime (sendMessage/isReady/stop + idle events).
 *
 * Implements both AgentRuntimeProcess (multi-agent) and IModelRunner (agent-loop).
 * Uses CodexMCPProcess for persistent MCP communication.
 */
export class CodexRuntimeProcess extends EventEmitter implements AgentRuntimeProcess, IModelRunner {
  readonly backendType = 'codex-mcp' as const;

  private wrapper: CodexMCPProcess;
  private state: 'idle' | 'busy' | 'dead' = 'idle';
  private stoppedDuringExecution = false;

  // ─── Metrics tracking ───
  private _requestCount = 0;
  private _failureCount = 0;
  private _totalLatencyMs = 0;
  private _lastRequestAt: number | null = null;

  constructor(options: CodexRuntimeProcessOptions) {
    super();
    const wrapperOptions: CodexMCPOptions = {
      model: options.model,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      sandbox: options.sandbox,
      command: options.command,
      compactPrompt: 'Summarize the conversation concisely, preserving key decisions and context.',
      timeoutMs: options.requestTimeout,
    };
    this.wrapper = new CodexMCPProcess(wrapperOptions);
  }

  // ─── IModelRunner.prompt() ─────────────────────────────────────────────

  async prompt(
    content: string,
    callbacks?: ClaudePromptCallbacks,
    _options?: PromptOptions
  ): Promise<ClaudePromptResult> {
    return this.sendMessage(content, callbacks);
  }

  // ─── AgentRuntimeProcess.sendMessage() ─────────────────────────────────

  async sendMessage(
    content: string,
    callbacks?: ClaudePromptCallbacks
  ): Promise<ClaudePromptResult> {
    if (this.state === 'dead') {
      throw new Error('Process is dead');
    }
    if (this.state === 'busy') {
      throw new Error('Process is busy with another request');
    }

    this.state = 'busy';
    const startTime = Date.now();
    this._requestCount++;
    this._lastRequestAt = startTime;

    try {
      const codexCallbacks: CodexPromptCallbacks | undefined = callbacks
        ? {
            onDelta: callbacks.onDelta,
            onError: callbacks.onError,
          }
        : undefined;

      const result = await this.wrapper.prompt(content, codexCallbacks);

      const normalized: ClaudePromptResult = {
        response: result.response,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_read_input_tokens: result.usage.cached_input_tokens,
        },
        session_id: result.session_id || this.wrapper.getSessionId(),
        cost_usd: result.cost_usd,
        toolUseBlocks: undefined,
        hasToolUse: false,
      };

      this._totalLatencyMs += Date.now() - startTime;
      callbacks?.onFinal?.({ content: normalized.response, toolUseBlocks: [] });
      return normalized;
    } catch (err) {
      this._failureCount++;
      this._totalLatencyMs += Date.now() - startTime;
      throw err;
    } finally {
      // Only reset to idle if not stopped during execution
      if (!this.stoppedDuringExecution) {
        this.state = 'idle';
        this.emit('idle');
      }
    }
  }

  // ─── IModelRunner session management ───────────────────────────────────

  setSessionId(id: string): void {
    this.wrapper.setSessionId(id);
  }

  setSystemPrompt(prompt: string): void {
    this.wrapper.setSystemPrompt(prompt);
  }

  // ─── IModelRunner health & metrics ─────────────────────────────────────

  isReady(): boolean {
    return this.state === 'idle';
  }

  isHealthy(): boolean {
    return this.state !== 'dead';
  }

  getMetrics(): RunnerMetrics {
    return {
      requestCount: this._requestCount,
      failureCount: this._failureCount,
      avgLatencyMs:
        this._requestCount > 0 ? Math.round(this._totalLatencyMs / this._requestCount) : 0,
      lastRequestAt: this._lastRequestAt,
    };
  }

  stop(): void {
    this.stoppedDuringExecution = this.state === 'busy';
    this.state = 'dead';
    this.wrapper.stop();
    this.emit('close', 0);
  }

  getSessionId(): string {
    return this.wrapper.getSessionId();
  }
}
