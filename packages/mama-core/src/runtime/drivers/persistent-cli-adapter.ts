/**
 * Persistent CLI Adapter - Wraps PersistentClaudeProcess with ClaudeCLIWrapper interface
 *
 * WHY THIS EXISTS:
 * - PersistentClaudeProcess uses stream-json for efficient multi-turn conversations
 * - AgentLoop expects ClaudeCLIWrapper interface (prompt, setSessionId, setSystemPrompt)
 * - This adapter bridges the two, enabling drop-in replacement
 *
 * KEY OPTIMIZATION:
 * - Tool results sent via stdin (tool_result message)
 * - Claude context preserved without re-sending full history
 * - System prompt sent only once at process start
 */

import { EventEmitter } from 'events';
import { PersistentClaudeProcess, PersistentProcessPool } from './persistent-cli-process.js';
import type {
  ClaudeAutonomousTurnEvent,
  ClaudeAutonomousTurnResultEvent,
  ClaudeSubagentStreamEvent,
} from './persistent-cli-process.js';
import type { SubagentEvent } from './codex-app-server-process.js';
import type {
  ClaudeCLIWrapperOptions,
  PromptCallbacks,
  PromptResult,
  ToolUseBlock,
} from './claude-cli-wrapper.js';
import {
  type IModelRunner,
  type PromptOptions,
  type RunnerMetrics,
  type SessionPolicyStatus,
} from './types.js';
import { ClaudeToolStreamProtocolError, NativeSessionUnavailableError } from './types.js';

// Re-export types for convenience
export type { ClaudeCLIWrapperOptions, PromptCallbacks, PromptResult, ToolUseBlock };

/**
 * PersistentCLIAdapter - Drop-in replacement for ClaudeCLIWrapper
 *
 * Implements the same interface but uses persistent CLI processes under the hood.
 * This enables efficient multi-turn conversations without re-sending system prompts.
 */

export class PersistentCLIAdapter extends EventEmitter implements IModelRunner {
  readonly backendType = 'claude' as const;

  /**
   * The CLI's own delegation: `Agent` with `run_in_background: true`. The parent stream
   * carries the spawn (`system/task_started` plus the launch tool_result that names the
   * child), the child's tool calls, its final text, and the completion notification, so a
   * spawn IS observable - PersistentClaudeProcess maps them and this adapter re-emits them
   * as `subagent` events with the same shape the Codex runner uses.
   */
  readonly supportsNativeSubagents = true;

  private options: ClaudeCLIWrapperOptions;
  private processPool: PersistentProcessPool;
  private channelKey: string;
  private currentProcess: PersistentClaudeProcess | null = null;
  private currentProcessChannelKey: string | null = null;
  private pendingToolResults: Map<string, { result: string; isError: boolean }> = new Map();
  private lastToolUseBlocks: ToolUseBlock[] = [];
  /** Processes whose subagent stream events are already wired to this adapter. */
  private readonly wiredProcesses = new WeakSet<PersistentClaudeProcess>();
  private readonly initializedProcesses = new WeakSet<PersistentClaudeProcess>();

  // ─── Metrics tracking ───
  private _requestCount = 0;
  private _failureCount = 0;
  private _totalLatencyMs = 0;
  private _lastRequestAt: number | null = null;

  constructor(options: ClaudeCLIWrapperOptions) {
    super();
    this.options = { ...options };
    this.channelKey = options.sessionId || 'default';
    this.processPool = new PersistentProcessPool({
      workspaceDir: options.workspaceDir,
      model: options.model,
      systemPrompt: options.systemPrompt,
      mcpConfigPath: options.mcpConfigPath,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      permissionMode: options.permissionMode,
      env: options.env,
      processEnv: options.processEnv,
      useGatewayTools: options.useGatewayTools,
      requestTimeout: options.requestTimeout,
      requestMaxMs: options.requestMaxMs,
      tools: options.tools,
      // Adaptive thinking effort (agent.effort) reaches the CLI as --effort.
      effort: options.effort,
      pluginDir: options.pluginDir,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    });
  }

  /**
   * Send a prompt to Claude
   *
   * This method:
   * 1. Gets or creates a persistent process for this channel
   * 2. Sends the message via stdin
   * 3. Parses the response from stdout
   * 4. Returns PromptResult compatible with ClaudeCLIWrapper
   */
  async prompt(
    content: string,
    callbacks?: PromptCallbacks,
    options?: PromptOptions
  ): Promise<PromptResult> {
    // Get or create process for this channel
    // NOTE: Do NOT pass sessionId to the process opts. The pool generates fresh randomUUID()
    // for --session-id. Passing the SessionPool UUID would cause Claude CLI to reload disk
    // history on process restart, leading to "Prompt is too long" errors when accumulated
    // context exceeds the window. options.sessionId is the pool ROUTING key only.
    const channelKey = options?.sessionId ?? options?.sessionKey ?? this.channelKey;
    const proc = await this.processPool.getProcess(channelKey, {
      model: options?.model || this.options.model,
      systemPrompt: options?.systemPrompt ?? this.options.systemPrompt,
      dangerouslySkipPermissions: this.options.dangerouslySkipPermissions,
      permissionMode: this.options.permissionMode,
      useGatewayTools: this.options.useGatewayTools,
      allowedTools: options?.allowedTools || this.options.allowedTools,
      disallowedTools: options?.disallowedTools || this.options.disallowedTools,
      // Per-call role projection of the CLI builtin set; '' is a real grant
      // (no builtins), so only nullish falls back to the pool default.
      tools: options?.tools ?? this.options.tools,
      // Coalesce to the adapter default so an absent per-call value never nulls
      // out the pool's construction-time requestTimeout (chat runs keep it).
      requestTimeout: options?.requestTimeout ?? this.options.requestTimeout,
      policyFingerprint: options?.sessionPolicyFingerprint,
      env: { ...this.options.env, MAMA_HOOK_FEATURES: 'rules,agents' },
    });
    // Keep the legacy accessor pointing at the most recent process, but NEVER
    // dereference this.currentProcess inside prompt() - concurrent calls race it.
    this.currentProcess = proc;
    this.currentProcessChannelKey = channelKey;
    this.wireSubagentEvents(proc, channelKey);

    // Pending tool results belong to the legacy single-channel path; only flush
    // them when this call routes to that same channel - flushing them into an
    // arbitrary per-call session would misdeliver them.
    if (channelKey === this.channelKey && this.pendingToolResults.size > 0) {
      // Verify the process is still alive before sending stale tool results
      // If the process was replaced (e.g., crashed and restarted), pending results are invalid
      if (!proc.isAlive()) {
        console.warn(
          `[PersistentAdapter] Process not alive, discarding ${this.pendingToolResults.size} pending tool results`
        );
        this.pendingToolResults.clear();
      } else {
        // Send tool results before the new message
        for (const [toolUseId, { result, isError }] of this.pendingToolResults) {
          try {
            console.log(`[PersistentAdapter] Sending pending tool_result: ${toolUseId}`);
            await proc.sendToolResult(toolUseId, result, isError);
          } catch (err) {
            console.error(`[PersistentAdapter] Failed to send tool_result ${toolUseId}:`, err);
          }
        }
        this.pendingToolResults.clear();
      }
    }

    // Send the user message with metrics tracking
    const startTime = Date.now();
    this._requestCount++;
    this._lastRequestAt = startTime;
    let latencyRecorded = false;
    const recordLatency = (): void => {
      if (!latencyRecorded) {
        latencyRecorded = true;
        this._totalLatencyMs += Date.now() - startTime;
      }
    };
    try {
      let prompt = content;
      if (options?.preparePrompt) {
        try {
          prompt = await options.preparePrompt({
            sessionId: proc.getSessionId(),
            isNewSession: !this.initializedProcesses.has(proc),
          });
        } catch (error) {
          if (!this.initializedProcesses.has(proc))
            this.processPool.retireProcess(channelKey, proc);
          throw error;
        }
      }
      // sendMessage can start a dead process for legacy callers. A prepared turn
      // must instead rebuild its context for the replacement before dispatch.
      if (!proc.isAlive())
        throw new NativeSessionUnavailableError('Claude process died while preparing input');
      const result = await proc.sendMessage(
        prompt,
        {
          ...callbacks,
          onAccepted: (receipt) => {
            this.initializedProcesses.add(proc);
            callbacks?.onAccepted?.(receipt);
          },
        },
        options?.nativeInputId
      );
      this.initializedProcesses.add(proc);
      recordLatency();

      // Track tool use blocks for potential tool result sending
      this.lastToolUseBlocks = result.toolUseBlocks || [];

      return result;
    } catch (err) {
      this._failureCount++;
      recordLatency();
      if (err instanceof ClaudeToolStreamProtocolError) {
        this.processPool.retireProcess(channelKey, proc);
      }
      throw err;
    }
  }

  // ─── Native background Agent (delegation) observation ────────────────────

  /**
   * Re-emit one process's background-Agent stream events as runner-level events.
   *
   * `subagent` carries the SAME shape the Codex runner emits, so
   * `attachSubagentWake` works unchanged. A completion the CLI answered with its own
   * follow-up turn is emitted as `subagentObserved` instead: that turn IS the owner
   * reacting, and a host wake on top of it would be a second turn for one child.
   */
  private wireSubagentEvents(proc: PersistentClaudeProcess, channelKey: string): void {
    if (this.wiredProcesses.has(proc)) return;
    // Structural test doubles stand in for the pooled process and carry neither the emitter
    // nor the background-agent accessor. Nothing to observe there.
    if (
      typeof (proc as { on?: unknown }).on !== 'function' ||
      typeof (proc as { hasLiveBackgroundAgents?: unknown }).hasLiveBackgroundAgents !== 'function'
    ) {
      return;
    }
    this.wiredProcesses.add(proc);

    proc.on('subagent', (event: ClaudeSubagentStreamEvent) => {
      const translated: SubagentEvent = {
        kind: event.kind,
        sessionKey: channelKey,
        parentThreadId: proc.getSessionId(),
        agentThreadId: event.agentThreadId,
        agentPath: event.agentPath,
        ...(event.status ? { status: event.status } : {}),
        ...(event.finalText ? { finalText: event.finalText } : {}),
      };
      if (event.kind === 'completed') {
        if (!event.wakeRequired) {
          console.log(
            `[PersistentAdapter] subagent ${event.agentThreadId} finished; the CLI's own ` +
              'turn carries the wake'
          );
          this.emit('subagentObserved', translated);
          return;
        }
      }
      this.emit('subagent', translated);
    });

    proc.on('autonomousTurn', (event: ClaudeAutonomousTurnEvent) => {
      this.emit('autonomousTurn', { ...event, sessionKey: channelKey });
    });

    proc.on('autonomousTurnResult', (event: ClaudeAutonomousTurnResultEvent) => {
      this.emit('autonomousTurnResult', { ...event, sessionKey: channelKey });
    });
  }

  /**
   * Send a tool result back to Claude
   *
   * This is a new method not in ClaudeCLIWrapper that enables efficient tool loops.
   * Instead of rebuilding the full history, we send just the tool result.
   */
  async sendToolResult(
    toolUseId: string,
    result: string,
    isError: boolean = false,
    callbacks?: PromptCallbacks
  ): Promise<PromptResult> {
    if (!this.currentProcess || !this.currentProcess.isAlive()) {
      throw new Error('No active process to send tool result to');
    }

    return this.currentProcess.sendToolResult(toolUseId, result, isError, callbacks);
  }

  /**
   * Queue a tool result to be sent with the next message
   *
   * Use this when you want to collect multiple tool results before continuing.
   */
  queueToolResult(toolUseId: string, result: string, isError: boolean = false): void {
    this.pendingToolResults.set(toolUseId, { result, isError });
  }

  /**
   * Check if there are pending tool results
   */
  hasPendingToolResults(): boolean {
    return this.pendingToolResults.size > 0;
  }

  /**
   * Get the last tool use blocks from the most recent response
   */
  getLastToolUseBlocks(): ToolUseBlock[] {
    return this.lastToolUseBlocks;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.options.sessionId || this.channelKey;
  }

  /**
   * Create a new session (creates new process)
   */
  resetSession(sessionId: string = this.channelKey): void {
    this.processPool.stopProcess(sessionId);
    if (this.currentProcessChannelKey === sessionId) {
      this.currentProcess = null;
      this.currentProcessChannelKey = null;
      this.lastToolUseBlocks = [];
    }
    if (sessionId === this.channelKey) {
      this.pendingToolResults.clear();
    }
  }

  /**
   * Set session ID (for channel-specific conversations)
   *
   * Note: This creates a new channel key, effectively switching channels.
   * The old process is kept alive for potential reuse.
   * Callers should use resetSession() if the old process is no longer needed to avoid orphan processes.
   *
   * @deprecated - per-call sessionId via prompt() options; this mutates shared adapter state
   */
  setSessionId(sessionId: string): void {
    this.options.sessionId = sessionId;
    this.channelKey = sessionId;
    // Don't stop the old process - it might be reused
    this.currentProcess = null;
    this.currentProcessChannelKey = null;
    this.pendingToolResults.clear();
    this.lastToolUseBlocks = [];
  }

  /**
   * Set system prompt
   *
   * IMPORTANT: This only affects new processes. Existing processes keep their prompt.
   * To apply a new system prompt, call resetSession() after setSystemPrompt().
   *
   * @deprecated - mutates shared spawn state; pass systemPrompt per prompt() call
   */
  setSystemPrompt(prompt: string): void {
    this.options.systemPrompt = prompt;
    // Note: Existing process is NOT updated
    // This matches ClaudeCLIWrapper behavior (system prompt is per-process)
  }

  /**
   * Get current options (for debugging)
   */
  getOptions(): ClaudeCLIWrapperOptions {
    return { ...this.options };
  }

  getSessionPolicyStatus(options: PromptOptions): SessionPolicyStatus {
    const channelKey = options.sessionId ?? options.sessionKey ?? this.channelKey;
    return this.processPool.getSessionPolicyStatus(channelKey, options.sessionPolicyFingerprint);
  }

  // ─── IModelRunner implementation ─────────────────────────────────────────

  /**
   * Check if the adapter has a live process ready to accept prompts.
   */
  isHealthy(): boolean {
    if (!this.currentProcess) return true; // no process yet = can create on demand
    return this.currentProcess.isAlive();
  }

  /**
   * Collect runtime metrics.
   */
  getMetrics(): RunnerMetrics {
    return {
      requestCount: this._requestCount,
      failureCount: this._failureCount,
      avgLatencyMs:
        this._requestCount > 0 ? Math.round(this._totalLatencyMs / this._requestCount) : 0,
      lastRequestAt: this._lastRequestAt,
    };
  }

  /**
   * Gracefully stop all processes (IModelRunner.stop).
   */
  stop(): void {
    this.stopAll();
  }

  /**
   * Stop all processes (cleanup) — legacy name, delegates to stop().
   */
  stopAll(): void {
    this.processPool.stopAll();
    this.currentProcess = null;
    this.currentProcessChannelKey = null;
    this.pendingToolResults.clear();
    this.lastToolUseBlocks = [];
  }

  /**
   * Check if the adapter is in persistent mode (always true for this adapter)
   */
  isPersistent(): boolean {
    return true;
  }

  /**
   * Get the current process state
   */
  getProcessState(): string {
    return this.currentProcess?.getState() || 'no_process';
  }

  /**
   * Get number of active processes in the pool
   */
  getActiveProcessCount(): number {
    return this.processPool.getActiveCount();
  }
}

/**
 * Factory function to create a ClaudeCLIWrapper-compatible adapter
 *
 * Usage:
 *   const wrapper = createPersistentCLIAdapter({ sessionId: 'discord-channel-123' });
 *   const result = await wrapper.prompt('Hello!');
 *
 * Each adapter instance maintains its own process pool. Processes are not shared across adapter instances.
 */
export function createPersistentCLIAdapter(options: ClaudeCLIWrapperOptions): PersistentCLIAdapter {
  return new PersistentCLIAdapter(options);
}
