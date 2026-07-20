import { EventEmitter } from 'events';
import {
  CodexMCPProcess,
  type CodexMCPOptions,
  type PromptCallbacks as CodexPromptCallbacks,
} from '../agent/codex-mcp-process.js';
import { CodexAppServerProcess } from '../agent/codex-app-server-process.js';
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
  transport?: 'app-server' | 'mcp';
  defaultSessionKey?: string;
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  requestTimeout?: number;
  codexHome?: string;
  isolatedHome?: string;
  registryRoot?: string;
  mcpConfigPath?: string;
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
 * Uses Codex app-server by default. The legacy MCP transport remains available
 * only as an explicit rollback path.
 */
export class CodexRuntimeProcess extends EventEmitter implements AgentRuntimeProcess, IModelRunner {
  readonly backendType = 'codex-mcp' as const;

  private readonly options: CodexRuntimeProcessOptions;
  private readonly transport: 'app-server' | 'mcp';
  private readonly mcpWrapper: CodexMCPProcess | undefined;
  private readonly appRunners = new Map<string, CodexAppServerProcess>();
  private defaultSessionKey: string;
  private systemPrompt: string;
  private state: 'idle' | 'busy' | 'dead' = 'idle';
  private stoppedDuringExecution = false;

  // ─── Metrics tracking ───
  private _requestCount = 0;
  private _failureCount = 0;
  private _totalLatencyMs = 0;
  private _lastRequestAt: number | null = null;

  constructor(options: CodexRuntimeProcessOptions) {
    super();
    this.options = { ...options };
    this.transport = options.transport ?? 'app-server';
    this.defaultSessionKey = options.defaultSessionKey ?? 'default';
    this.systemPrompt = options.systemPrompt ?? '';
    if (this.transport === 'mcp') {
      const wrapperOptions: CodexMCPOptions = {
        model: options.model,
        systemPrompt: options.systemPrompt,
        cwd: options.cwd,
        sandbox: options.sandbox,
        codexHome: options.codexHome,
        command: options.command,
        mcpConfigPath: options.mcpConfigPath,
        compactPrompt:
          'Summarize the conversation concisely, preserving key decisions and context.',
        timeoutMs: options.requestTimeout,
      };
      this.mcpWrapper = new CodexMCPProcess(wrapperOptions);
    }
  }

  // ─── IModelRunner.prompt() ─────────────────────────────────────────────

  async prompt(
    content: string,
    callbacks?: ClaudePromptCallbacks,
    options?: PromptOptions
  ): Promise<ClaudePromptResult> {
    return this.execute(content, callbacks, options);
  }

  // ─── AgentRuntimeProcess.sendMessage() ─────────────────────────────────

  async sendMessage(
    content: string,
    callbacks?: ClaudePromptCallbacks
  ): Promise<ClaudePromptResult> {
    return this.execute(content, callbacks);
  }

  private async execute(
    content: string,
    callbacks?: ClaudePromptCallbacks,
    promptOptions?: PromptOptions
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
      const normalized =
        this.transport === 'mcp'
          ? await this.promptMcp(content, callbacks, promptOptions)
          : await this.promptAppServer(content, promptOptions);

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

  private async promptMcp(
    content: string,
    callbacks: ClaudePromptCallbacks | undefined,
    options: PromptOptions | undefined
  ): Promise<ClaudePromptResult> {
    if (!this.mcpWrapper) {
      throw new Error('Codex MCP rollback transport is unavailable');
    }
    const codexCallbacks: CodexPromptCallbacks | undefined = callbacks
      ? { onDelta: callbacks.onDelta, onError: callbacks.onError }
      : undefined;
    const result = await this.mcpWrapper.prompt(
      content,
      codexCallbacks,
      options?.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : undefined
    );
    return {
      response: result.response,
      usage: {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_input_tokens: result.usage.cached_input_tokens,
      },
      session_id: result.session_id || this.mcpWrapper.getSessionId(),
      cost_usd: result.cost_usd,
      toolUseBlocks: undefined,
      hasToolUse: false,
    };
  }

  private async promptAppServer(
    content: string,
    options: PromptOptions | undefined
  ): Promise<ClaudePromptResult> {
    const sessionKey = options?.sessionKey ?? options?.sessionId ?? this.defaultSessionKey;
    let runner = this.appRunners.get(sessionKey);
    if (!runner) {
      runner = new CodexAppServerProcess({
        sessionKey,
        model: options?.model ?? this.options.model ?? 'gpt-5.4',
        systemPrompt: options?.systemPrompt ?? this.systemPrompt,
        cwd: this.options.cwd ?? process.cwd(),
        sandbox: this.options.sandbox ?? 'workspace-write',
        command: this.options.command,
        requestTimeout: options?.requestTimeout ?? this.options.requestTimeout,
        codexHome: this.options.codexHome,
        isolatedHome: this.options.isolatedHome,
        registryRoot: this.options.registryRoot,
        mcpConfigPath: this.options.mcpConfigPath,
      });
      this.appRunners.set(sessionKey, runner);
    }
    if (options?.resumeSession === false) {
      await runner.reset();
    }
    return runner.prompt(content);
  }

  // ─── IModelRunner session management ───────────────────────────────────

  setSessionId(id: string): void {
    this.defaultSessionKey = id;
    this.mcpWrapper?.setSessionId(id);
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    this.mcpWrapper?.setSystemPrompt(prompt);
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
    this.mcpWrapper?.stop();
    for (const runner of this.appRunners.values()) {
      void runner.stop();
    }
    this.appRunners.clear();
    this.emit('close', 0);
  }

  getSessionId(): string {
    return (
      this.mcpWrapper?.getSessionId() ??
      this.appRunners.get(this.defaultSessionKey)?.getThreadId() ??
      ''
    );
  }
}
