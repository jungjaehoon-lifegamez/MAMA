/**
 * Swarm Event Reporter
 *
 * Converts SwarmTaskRunner events into formatted channel messages.
 * Platform-agnostic (Discord/Slack) via callback pattern.
 *
 * Features:
 * - Subscribes to task-completed, task-failed, session-complete, file-conflict events
 * - Formats messages with emoji and concise details
 * - Respects 1800 character limit for Discord compatibility
 * - Verbose mode for detailed task information
 * - Error-resilient message sending (logs errors, doesn't throw)
 *
 * @module swarm-event-reporter
 * @version 1.0
 */

import type { SwarmTaskRunner, TaskExecutionResult } from './swarm-task-runner.js';

/**
 * Callback to send formatted messages to a platform channel
 */
export type MessageSender = (channelId: string, message: string) => Promise<void>;

/**
 * Configuration options for SwarmEventReporter
 */
export interface SwarmEventReporterOptions {
  /** Callback function to send messages to a channel */
  sendMessage: MessageSender;
  /** Channel ID where reports should be sent */
  channelId: string;
  /** Enable verbose mode with detailed task information (default: false) */
  verbose?: boolean;
}

/**
 * Swarm Event Reporter
 *
 * Listens to SwarmTaskRunner events and sends formatted messages to a channel.
 * Platform-agnostic design allows integration with Discord, Slack, or any messaging system.
 *
 * @example
 * ```typescript
 * const reporter = new SwarmEventReporter(taskRunner, {
 *   sendMessage: async (channelId, msg) => {
 *     await discordClient.sendMessage(channelId, msg);
 *   },
 *   channelId: 'channel-123',
 *   verbose: true
 * });
 *
 * reporter.start(); // Begin listening
 * // ...
 * reporter.stop(); // Stop listening
 * ```
 */
export class SwarmEventReporter {
  private runner: SwarmTaskRunner;
  private options: SwarmEventReporterOptions;
  private isStarted = false;

  // Event handler references (needed for removeListener)
  private taskCompletedHandler: ((result: TaskExecutionResult) => void) | null = null;
  private taskFailedHandler: ((result: TaskExecutionResult) => void) | null = null;
  private taskRetriedHandler:
    | ((result: TaskExecutionResult, attempt: number, maxRetries: number) => void)
    | null = null;
  private sessionCompleteHandler: ((sessionId: string) => void) | null = null;
  private fileConflictHandler:
    | ((taskId: string, conflictingFiles: string[], conflictingTasks: string[]) => void)
    | null = null;

  constructor(runner: SwarmTaskRunner, options: SwarmEventReporterOptions) {
    this.runner = runner;
    this.options = options;
  }

  /**
   * Start listening to SwarmTaskRunner events
   *
   * Registers event handlers for task lifecycle events.
   * Idempotent - calling multiple times has no effect.
   */
  start(): void {
    if (this.isStarted) {
      console.warn('[SwarmEventReporter] Already started, ignoring duplicate start() call');
      return;
    }

    // task-completed event
    this.taskCompletedHandler = (result: TaskExecutionResult) => {
      const message = this.formatTaskCompleted(result);
      this.sendMessage(message);
    };
    this.runner.on('task-completed', this.taskCompletedHandler);

    // task-failed event
    this.taskFailedHandler = (result: TaskExecutionResult) => {
      const message = this.formatTaskFailed(result);
      this.sendMessage(message);
    };
    this.runner.on('task-failed', this.taskFailedHandler);

    // task-retried event
    this.taskRetriedHandler = (
      result: TaskExecutionResult,
      attempt: number,
      maxRetries: number
    ) => {
      const message = this.formatTaskRetried(result, attempt, maxRetries);
      this.sendMessage(message);
    };
    this.runner.on('task-retried', this.taskRetriedHandler);

    // session-complete event
    this.sessionCompleteHandler = (sessionId: string) => {
      const message = this.formatSessionComplete(sessionId);
      this.sendMessage(message);
    };
    this.runner.on('session-complete', this.sessionCompleteHandler);

    // file-conflict event
    this.fileConflictHandler = (
      taskId: string,
      conflictingFiles: string[],
      conflictingTasks: string[]
    ) => {
      const message = this.formatFileConflict(taskId, conflictingFiles, conflictingTasks);
      this.sendMessage(message);
    };
    this.runner.on('file-conflict', this.fileConflictHandler);

    this.isStarted = true;
    console.log(`[SwarmEventReporter] Started reporting to channel ${this.options.channelId}`);
  }

  /**
   * Stop listening to SwarmTaskRunner events
   *
   * Removes all registered event handlers.
   * Idempotent - calling multiple times has no effect.
   */
  stop(): void {
    if (!this.isStarted) {
      console.warn('[SwarmEventReporter] Not started, ignoring stop() call');
      return;
    }

    if (this.taskCompletedHandler) {
      this.runner.removeListener('task-completed', this.taskCompletedHandler);
      this.taskCompletedHandler = null;
    }

    if (this.taskFailedHandler) {
      this.runner.removeListener('task-failed', this.taskFailedHandler);
      this.taskFailedHandler = null;
    }

    if (this.taskRetriedHandler) {
      this.runner.removeListener('task-retried', this.taskRetriedHandler);
      this.taskRetriedHandler = null;
    }

    if (this.sessionCompleteHandler) {
      this.runner.removeListener('session-complete', this.sessionCompleteHandler);
      this.sessionCompleteHandler = null;
    }

    if (this.fileConflictHandler) {
      this.runner.removeListener('file-conflict', this.fileConflictHandler);
      this.fileConflictHandler = null;
    }

    this.isStarted = false;
    console.log('[SwarmEventReporter] Stopped reporting');
  }

  /**
   * Format task-completed event message
   */
  private formatTaskCompleted(result: TaskExecutionResult): string {
    const taskIdShort = result.taskId.substring(0, 8);
    let message = `✅ Task \`${taskIdShort}\` completed by agent \`${result.agentId}\``;

    if (this.options.verbose && result.result) {
      const resultPreview = this.truncate(result.result, 80);
      message += `\n> ${resultPreview}`;
    }

    return this.enforceLimit(message);
  }

  /**
   * Format task-failed event message
   */
  private formatTaskFailed(result: TaskExecutionResult): string {
    const taskIdShort = result.taskId.substring(0, 8);
    let message = `❌ Task \`${taskIdShort}\` failed`;

    if (result.error) {
      const errorPreview = this.truncate(result.error, 100);
      message += `\n> Error: ${errorPreview}`;
    }

    if (this.options.verbose && result.agentId) {
      message += `\n> Agent: \`${result.agentId}\``;
    }

    return this.enforceLimit(message);
  }

  /**
   * Format task-retried event message
   */
  private formatTaskRetried(
    result: TaskExecutionResult,
    attempt: number,
    maxRetries: number
  ): string {
    const taskIdShort = result.taskId.substring(0, 8);
    let message = `🔄 Task \`${taskIdShort}\` retrying (attempt ${attempt}/${maxRetries})`;

    if (this.options.verbose && result.error) {
      const errorPreview = this.truncate(result.error, 80);
      message += `\n> Error: ${errorPreview}`;
    }

    return this.enforceLimit(message);
  }

  /**
   * Format session-complete event message
   */
  private formatSessionComplete(sessionId: string): string {
    const sessionIdShort = sessionId.substring(0, 8);
    const message = `🏁 Session \`${sessionIdShort}\` complete — all tasks finished`;

    return this.enforceLimit(message);
  }

  /**
   * Format file-conflict event message
   */
  private formatFileConflict(
    taskId: string,
    conflictingFiles: string[],
    conflictingTasks: string[]
  ): string {
    const taskIdShort = taskId.substring(0, 8);
    const conflictingTasksShort = conflictingTasks.map((id) => id.substring(0, 8));

    const tasksList = conflictingTasksShort.map((id) => `\`${id}\``).join(', ');
    let message = `⚠️ File conflict: task \`${taskIdShort}\` shares files with ${tasksList}`;

    if (this.options.verbose && conflictingFiles.length > 0) {
      const filesPreview = conflictingFiles.slice(0, 5).join(', ');
      const moreFiles =
        conflictingFiles.length > 5 ? ` (+${conflictingFiles.length - 5} more)` : '';
      message += `\n> Files: ${filesPreview}${moreFiles}`;
    }

    return this.enforceLimit(message);
  }

  /**
   * Truncate text to max length with ellipsis
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Enforce 1800 character limit for Discord compatibility
   */
  private enforceLimit(message: string): string {
    return this.truncate(message, 1800);
  }

  /**
   * Send message via callback, with error handling
   */
  private sendMessage(message: string): void {
    void this.options.sendMessage(this.options.channelId, message).catch((error) => {
      console.error('[SwarmEventReporter] Failed to send message:', error);
    });
  }
}
