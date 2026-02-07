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

import { PersistentClaudeProcess, PersistentProcessPool } from './persistent-cli-process.js';
import type {
  ClaudeCLIWrapperOptions,
  PromptCallbacks,
  PromptResult,
  ToolUseBlock,
} from './claude-cli-wrapper.js';

// Re-export types for convenience
export type { ClaudeCLIWrapperOptions, PromptCallbacks, PromptResult, ToolUseBlock };

/**
 * PersistentCLIAdapter - Drop-in replacement for ClaudeCLIWrapper
 *
 * Implements the same interface but uses persistent CLI processes under the hood.
 * This enables efficient multi-turn conversations without re-sending system prompts.
 */
export class PersistentCLIAdapter {
  private options: ClaudeCLIWrapperOptions;
  private processPool: PersistentProcessPool;
  private channelKey: string;
  private currentProcess: PersistentClaudeProcess | null = null;
  private pendingToolResults: Map<string, { result: string; isError: boolean }> = new Map();
  private lastToolUseBlocks: ToolUseBlock[] = [];

  constructor(options: ClaudeCLIWrapperOptions = {}) {
    this.options = { ...options };
    this.channelKey = options.sessionId || 'default';
    this.processPool = new PersistentProcessPool({
      model: options.model,
      systemPrompt: options.systemPrompt,
      mcpConfigPath: options.mcpConfigPath,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      useGatewayTools: options.useGatewayTools,
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
    options?: { model?: string; resumeSession?: boolean }
  ): Promise<PromptResult> {
    // Get or create process for this channel
    this.currentProcess = await this.processPool.getProcess(this.channelKey, {
      sessionId: this.options.sessionId || this.channelKey,
      model: options?.model || this.options.model,
      systemPrompt: this.options.systemPrompt,
      dangerouslySkipPermissions: this.options.dangerouslySkipPermissions,
      useGatewayTools: this.options.useGatewayTools,
    });

    // Check if we have pending tool results to send first
    if (this.pendingToolResults.size > 0) {
      // Verify the process is still alive before sending stale tool results
      // If the process was replaced (e.g., crashed and restarted), pending results are invalid
      if (!this.currentProcess.isAlive()) {
        console.warn(
          `[PersistentAdapter] Process not alive, discarding ${this.pendingToolResults.size} pending tool results`
        );
        this.pendingToolResults.clear();
      } else {
        // Send tool results before the new message
        for (const [toolUseId, { result, isError }] of this.pendingToolResults) {
          try {
            console.log(`[PersistentAdapter] Sending pending tool_result: ${toolUseId}`);
            await this.currentProcess.sendToolResult(toolUseId, result, isError);
          } catch (err) {
            console.error(`[PersistentAdapter] Failed to send tool_result ${toolUseId}:`, err);
          }
        }
        this.pendingToolResults.clear();
      }
    }

    // Send the user message
    const result = await this.currentProcess.sendMessage(content, callbacks);

    // Track tool use blocks for potential tool result sending
    this.lastToolUseBlocks = result.toolUseBlocks || [];

    return result;
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
  resetSession(): void {
    this.processPool.stopProcess(this.channelKey);
    this.currentProcess = null;
    this.pendingToolResults.clear();
    this.lastToolUseBlocks = [];
  }

  /**
   * Set session ID (for channel-specific conversations)
   *
   * Note: This creates a new channel key, effectively switching channels.
   * The old process is kept alive for potential reuse.
   * Callers should use resetSession() if the old process is no longer needed to avoid orphan processes.
   */
  setSessionId(sessionId: string): void {
    this.options.sessionId = sessionId;
    this.channelKey = sessionId;
    // Don't stop the old process - it might be reused
    this.currentProcess = null;
    this.pendingToolResults.clear();
    this.lastToolUseBlocks = [];
  }

  /**
   * Set system prompt
   *
   * IMPORTANT: This only affects new processes. Existing processes keep their prompt.
   * To apply a new system prompt, call resetSession() after setSystemPrompt().
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

  /**
   * Stop all processes (cleanup)
   */
  stopAll(): void {
    this.processPool.stopAll();
    this.currentProcess = null;
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
export function createPersistentCLIAdapter(
  options: ClaudeCLIWrapperOptions = {}
): PersistentCLIAdapter {
  return new PersistentCLIAdapter(options);
}
