import { EventEmitter } from 'events';
import { CodexAppServerProcess } from '../agent/codex-app-server-process.js';
import type {
  PromptCallbacks as ClaudePromptCallbacks,
  PromptResult as ClaudePromptResult,
} from '../agent/persistent-cli-process.js';
import type {
  IModelRunner,
  RunnerMetrics,
  PromptOptions,
  SessionPolicyStatus,
} from '../agent/model-runner.js';

export interface AgentRuntimeProcess {
  sendMessage(content: string, callbacks?: ClaudePromptCallbacks): Promise<ClaudePromptResult>;
  isReady(): boolean;
  stop(): void | Promise<void>;
  getSessionId?(): string;
  on(event: 'idle' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
}

export interface CodexRuntimeProcessOptions {
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
}

/**
 * Session-persistent Codex wrapper with the same minimal contract used by
 * multi-agent runtime (sendMessage/isReady/stop + idle events).
 *
 * Implements both AgentRuntimeProcess (multi-agent) and IModelRunner (agent-loop).
 * Uses one Codex app-server connection and multiplexes durable threads by
 * session key. Different sessions may run concurrently; turns for the same
 * session are serialized by CodexAppServerProcess.
 */
export class CodexRuntimeProcess extends EventEmitter implements AgentRuntimeProcess, IModelRunner {
  readonly backendType = 'codex' as const;

  private readonly options: CodexRuntimeProcessOptions;
  private readonly appServer: CodexAppServerProcess;
  private defaultSessionKey: string;
  private systemPrompt: string;
  private stopped = false;
  private activeRequests = 0;

  // ─── Metrics tracking ───
  private _requestCount = 0;
  private _failureCount = 0;
  private _totalLatencyMs = 0;
  private _lastRequestAt: number | null = null;

  constructor(options: CodexRuntimeProcessOptions) {
    super();
    this.options = { ...options };
    this.defaultSessionKey = options.defaultSessionKey ?? 'default';
    this.systemPrompt = options.systemPrompt ?? '';
    this.appServer = new CodexAppServerProcess({
      sessionKey: this.defaultSessionKey,
      model: options.model ?? 'gpt-5.4',
      systemPrompt: this.systemPrompt,
      cwd: options.cwd ?? process.cwd(),
      sandbox: options.sandbox ?? 'workspace-write',
      command: options.command,
      requestTimeout: options.requestTimeout,
      codexHome: options.codexHome,
      isolatedHome: options.isolatedHome,
      registryRoot: options.registryRoot,
      mcpConfigPath: options.mcpConfigPath,
    });
  }

  // ─── IModelRunner.prompt() ─────────────────────────────────────────────

  async prompt(
    content: string,
    callbacks?: ClaudePromptCallbacks,
    options?: PromptOptions
  ): Promise<ClaudePromptResult> {
    return this.execute(content, callbacks, options);
  }

  getSessionPolicyStatus(options: PromptOptions): SessionPolicyStatus {
    return this.appServer.getSessionPolicyStatus({
      sessionKey: options.sessionKey ?? options.sessionId ?? this.defaultSessionKey,
      model: options.model ?? this.options.model,
      systemPrompt: options.systemPrompt ?? this.systemPrompt,
      requestTimeout: options.requestTimeout ?? this.options.requestTimeout,
      policyFingerprint: options.sessionPolicyFingerprint,
      resumeSession: options.resumeSession,
      hostToolBridge: options.hostToolBridge,
    });
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
    if (this.stopped) {
      throw this.notifyError(new Error('Process is dead'), callbacks);
    }

    this.activeRequests++;
    const startTime = Date.now();
    this._requestCount++;
    this._lastRequestAt = startTime;

    try {
      const normalized = await this.appServer.prompt(content, callbacks, {
        sessionKey: promptOptions?.sessionKey ?? promptOptions?.sessionId ?? this.defaultSessionKey,
        model: promptOptions?.model ?? this.options.model,
        systemPrompt: promptOptions?.systemPrompt ?? this.systemPrompt,
        requestTimeout: promptOptions?.requestTimeout ?? this.options.requestTimeout,
        policyFingerprint: promptOptions?.sessionPolicyFingerprint,
        resumeSession: promptOptions?.resumeSession,
        hostToolBridge: promptOptions?.hostToolBridge,
      });

      this._totalLatencyMs += Date.now() - startTime;
      callbacks?.onFinal?.({ content: normalized.response, toolUseBlocks: [] });
      return normalized;
    } catch (err) {
      this._failureCount++;
      this._totalLatencyMs += Date.now() - startTime;
      throw this.notifyError(err, callbacks);
    } finally {
      this.activeRequests--;
      if (!this.stopped && this.activeRequests === 0) {
        this.emit('idle');
      }
    }
  }

  private notifyError(error: unknown, callbacks?: ClaudePromptCallbacks): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      callbacks?.onError?.(normalized);
    } catch {
      // Consumer callback failures must not replace the model failure.
    }
    return normalized;
  }

  // ─── IModelRunner session management ───────────────────────────────────

  setSessionId(id: string): void {
    this.defaultSessionKey = id;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  // ─── IModelRunner health & metrics ─────────────────────────────────────

  isReady(): boolean {
    return !this.stopped;
  }

  isHealthy(): boolean {
    return !this.stopped;
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

  async stop(): Promise<void> {
    this.stopped = true;
    await this.appServer.stop();
    this.emit('close', 0);
  }

  getSessionId(): string {
    return this.appServer.getThreadId(this.defaultSessionKey) ?? '';
  }
}
