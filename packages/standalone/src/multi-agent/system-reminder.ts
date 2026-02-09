/**
 * System Reminder Service
 *
 * Notification service that sends system reminders to chat platforms (Discord/Slack)
 * and formats them for agent context injection.
 *
 * Features:
 * - Formats background task event messages (started, completed, failed)
 * - Sends notifications to Discord/Slack channels via callbacks
 * - Batches multiple completions within a configurable window into single notifications
 * - Provides formatted context for agent conversation injection
 * - Supports both English and Korean
 * - Stores last 50 reminders per channel for context retrieval
 *
 * @module system-reminder
 * @version 1.0
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/**
 * System reminder event types for background task lifecycle
 */
export type SystemReminderType =
  | 'task-started'
  | 'task-completed'
  | 'task-failed'
  | 'all-tasks-complete'
  | 'delegation-started'
  | 'delegation-completed';

/**
 * A single system reminder event
 */
export interface SystemReminder {
  /** Event type */
  type: SystemReminderType;
  /** Background task ID */
  taskId: string;
  /** Human-readable description of the task */
  description: string;
  /** Agent that executed the task */
  agentId: string;
  /** Agent that requested the task */
  requestedBy: string;
  /** Channel where the task was initiated */
  channelId: string;
  /** Task duration in milliseconds (for completed/failed) */
  duration?: number;
  /** Error message (for failed tasks) */
  error?: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

/**
 * Callback for sending formatted notifications to chat platforms.
 * Actual Discord/Slack message sending is handled externally.
 */
export type ChatNotifyCallback = (
  channelId: string,
  message: string,
  source: 'discord' | 'slack'
) => Promise<void>;

/**
 * Configuration options for SystemReminderService
 */
export interface SystemReminderServiceOptions {
  /** Batch window in milliseconds (default: 2000) */
  batchWindowMs?: number;
  /** Maximum reminders per batch (default: 10) */
  maxBatchSize?: number;
  /** Enable sending chat notifications (default: true) */
  enableChatNotifications?: boolean;
}

/**
 * Supported languages for reminder formatting
 */
export type ReminderLanguage = 'en' | 'ko';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_WINDOW_MS = 2000;
const DEFAULT_MAX_BATCH_SIZE = 10;
const MAX_REMINDERS_PER_CHANNEL = 50;
const DISCORD_MESSAGE_LIMIT = 1800;

// ---------------------------------------------------------------------------
// i18n labels
// ---------------------------------------------------------------------------

interface ReminderLabels {
  taskStarted: string;
  taskCompleted: string;
  taskFailed: string;
  allTasksComplete: string;
  delegationStarted: string;
  delegationCompleted: string;
  id: string;
  agent: string;
  task: string;
  requestedBy: string;
  duration: string;
  error: string;
  succeeded: string;
  failed: string;
  outOf: string;
}

const labels: Record<ReminderLanguage, ReminderLabels> = {
  en: {
    taskStarted: 'Background Task Started',
    taskCompleted: 'Background Task Completed',
    taskFailed: 'Background Task Failed',
    allTasksComplete: 'All Background Tasks Complete',
    delegationStarted: 'Delegation Started',
    delegationCompleted: 'Delegation Completed',
    id: 'ID',
    agent: 'Agent',
    task: 'Task',
    requestedBy: 'Requested by',
    duration: 'Duration',
    error: 'Error',
    succeeded: 'succeeded',
    failed: 'failed',
    outOf: 'out of',
  },
  ko: {
    taskStarted: '백그라운드 작업 시작',
    taskCompleted: '백그라운드 작업 완료',
    taskFailed: '백그라운드 작업 실패',
    allTasksComplete: '모든 백그라운드 작업 완료',
    delegationStarted: '위임 시작',
    delegationCompleted: '위임 완료',
    id: 'ID',
    agent: '에이전트',
    task: '작업',
    requestedBy: '요청자',
    duration: '소요 시간',
    error: '오류',
    succeeded: '성공',
    failed: '실패',
    outOf: '중',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format duration from milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

/**
 * Truncate text to a maximum length, appending ellipsis if needed
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

// ---------------------------------------------------------------------------
// Pending batch entry
// ---------------------------------------------------------------------------

interface PendingBatch {
  reminders: SystemReminder[];
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// SystemReminderService
// ---------------------------------------------------------------------------

/**
 * System Reminder Service
 *
 * Manages background task notifications for chat platforms and agent context injection.
 * Batches multiple completions within a configurable window into single messages.
 *
 * @example
 * ```typescript
 * const service = new SystemReminderService({
 *   batchWindowMs: 2000,
 *   enableChatNotifications: true,
 * });
 *
 * service.registerCallback(async (channelId, message, source) => {
 *   await discordSend(channelId, message);
 * }, 'discord');
 *
 * await service.notify({
 *   type: 'task-started',
 *   taskId: 'bg_abc12345',
 *   description: 'Implement auth module',
 *   agentId: 'developer',
 *   requestedBy: 'sisyphus',
 *   channelId: 'channel-123',
 *   timestamp: Date.now(),
 * });
 * ```
 */
export class SystemReminderService {
  private readonly batchWindowMs: number;
  private readonly maxBatchSize: number;
  private readonly enableChatNotifications: boolean;

  /** Per-channel reminder history (last MAX_REMINDERS_PER_CHANNEL) */
  private channelReminders: Map<string, SystemReminder[]> = new Map();

  /** Per-channel pending batch of completion/failure reminders */
  private pendingBatches: Map<string, PendingBatch> = new Map();

  /** Registered platform callbacks */
  private callbacks: Map<'discord' | 'slack', ChatNotifyCallback> = new Map();

  /** Language for formatting */
  private language: ReminderLanguage = 'en';

  constructor(options: SystemReminderServiceOptions = {}) {
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.enableChatNotifications = options.enableChatNotifications ?? true;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a chat platform callback for sending notifications
   *
   * @param callback - Function to send messages
   * @param source - Platform identifier
   */
  registerCallback(callback: ChatNotifyCallback, source: 'discord' | 'slack'): void {
    this.callbacks.set(source, callback);
    console.log(`[SystemReminder] Registered ${source} callback`);
  }

  /**
   * Remove a previously registered callback
   *
   * @param source - Platform identifier to unregister
   */
  unregisterCallback(source: 'discord' | 'slack'): void {
    this.callbacks.delete(source);
    console.log(`[SystemReminder] Unregistered ${source} callback`);
  }

  /**
   * Set the language for formatted messages
   *
   * @param language - 'en' or 'ko'
   */
  setLanguage(language: ReminderLanguage): void {
    this.language = language;
  }

  /**
   * Process and dispatch a system reminder.
   *
   * - `task-started` reminders are sent immediately.
   * - `task-completed` and `task-failed` reminders are batched within the configured window.
   * - `all-tasks-complete` reminders are sent immediately.
   *
   * Reminders are always stored in channel history regardless of notification setting.
   *
   * @param reminder - The system reminder to process
   */
  async notify(reminder: SystemReminder): Promise<void> {
    this.storeReminder(reminder);

    if (!this.enableChatNotifications) {
      return;
    }

    if (
      reminder.type === 'task-started' ||
      reminder.type === 'all-tasks-complete' ||
      reminder.type === 'delegation-started' ||
      reminder.type === 'delegation-completed'
    ) {
      const message = this.formatChatMessage(reminder);
      await this.sendToAllCallbacks(reminder.channelId, message);
      return;
    }

    this.addToBatch(reminder);
  }

  /**
   * Format a single reminder as a chat message (Discord/Slack compatible markdown)
   *
   * @param reminder - The system reminder to format
   * @returns Formatted message string
   */
  formatChatMessage(reminder: SystemReminder): string {
    const l = labels[this.language];

    switch (reminder.type) {
      case 'task-started':
        return this.enforceLimit(
          [
            `\uD83D\uDD04 **${l.taskStarted}**`,
            `**${l.id}:** \`${reminder.taskId}\``,
            `**${l.agent}:** ${reminder.agentId}`,
            `**${l.task}:** ${reminder.description}`,
            `**${l.requestedBy}:** ${reminder.requestedBy}`,
          ].join('\n')
        );

      case 'task-completed': {
        const lines = [
          `\u2705 **${l.taskCompleted}**`,
          `**${l.id}:** \`${reminder.taskId}\``,
          `**${l.agent}:** ${reminder.agentId}`,
        ];
        if (reminder.duration !== undefined) {
          lines.push(`**${l.duration}:** ${formatDuration(reminder.duration)}`);
        }
        lines.push(`**${l.task}:** ${reminder.description}`);
        return this.enforceLimit(lines.join('\n'));
      }

      case 'task-failed': {
        const lines = [
          `\u274C **${l.taskFailed}**`,
          `**${l.id}:** \`${reminder.taskId}\``,
          `**${l.agent}:** ${reminder.agentId}`,
        ];
        if (reminder.error) {
          lines.push(`**${l.error}:** ${reminder.error}`);
        }
        return this.enforceLimit(lines.join('\n'));
      }

      case 'all-tasks-complete':
        return this.enforceLimit(`\uD83D\uDCCB **${l.allTasksComplete}**`);

      case 'delegation-started':
        return this.enforceLimit(
          [
            `\uD83D\uDD00 **${l.delegationStarted}**`,
            `**${l.agent}:** ${reminder.agentId}`,
            `**${l.task}:** ${reminder.description}`,
            `**${l.requestedBy}:** ${reminder.requestedBy}`,
          ].join('\n')
        );

      case 'delegation-completed': {
        const dLines = [
          `\u2705 **${l.delegationCompleted}**`,
          `**${l.agent}:** ${reminder.agentId}`,
        ];
        if (reminder.duration !== undefined) {
          dLines.push(`**${l.duration}:** ${formatDuration(reminder.duration)}`);
        }
        dLines.push(`**${l.task}:** ${reminder.description}`);
        return this.enforceLimit(dLines.join('\n'));
      }

      default:
        return '';
    }
  }

  /**
   * Format multiple reminders into a single batch notification message
   *
   * @param reminders - Array of completed/failed reminders
   * @returns Formatted batch message string
   */
  formatBatchMessage(reminders: SystemReminder[]): string {
    if (reminders.length === 0) {
      return '';
    }

    if (reminders.length === 1) {
      return this.formatChatMessage(reminders[0]);
    }

    const l = labels[this.language];
    const lines: string[] = [`\uD83D\uDCCB **${l.allTasksComplete}**`, ''];

    let succeededCount = 0;
    let failedCount = 0;

    for (const r of reminders) {
      if (r.type === 'task-completed') {
        succeededCount++;
        const durationStr = r.duration !== undefined ? ` (${formatDuration(r.duration)})` : '';
        lines.push(`\u2705 \`${r.taskId}\` \u2014 ${r.description}${durationStr}`);
      } else if (r.type === 'task-failed') {
        failedCount++;
        const errorStr = r.error ? ` (${l.failed}: ${r.error})` : '';
        lines.push(`\u274C \`${r.taskId}\` \u2014 ${r.description}${errorStr}`);
      }
    }

    const total = succeededCount + failedCount;
    lines.push('');
    lines.push(
      `**${succeededCount} ${l.succeeded}, ${failedCount} ${l.failed}** ${l.outOf} ${total} tasks.`
    );

    return this.enforceLimit(lines.join('\n'));
  }

  /**
   * Get recent reminders for a channel (for agent context injection)
   *
   * @param channelId - The channel to retrieve reminders for
   * @param limit - Maximum number of reminders to return (default: 10)
   * @returns Array of recent reminders, newest first
   */
  getRecentReminders(channelId: string, limit: number = 10): SystemReminder[] {
    const reminders = this.channelReminders.get(channelId);
    if (!reminders || reminders.length === 0) {
      return [];
    }
    return reminders.slice(-limit).reverse();
  }

  /**
   * Clear all stored reminders for a channel
   *
   * @param channelId - The channel to clear
   */
  clearChannel(channelId: string): void {
    this.channelReminders.delete(channelId);

    const pending = this.pendingBatches.get(channelId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingBatches.delete(channelId);
    }

    console.log(`[SystemReminder] Cleared reminders for channel ${channelId}`);
  }

  /**
   * Format recent reminders as context string for agent conversation injection
   *
   * @param channelId - Channel to pull context from
   * @param limit - Maximum number of reminders to include (default: 5)
   * @returns Formatted context string, or empty string if no reminders
   */
  formatContextInjection(channelId: string, limit: number = 5): string {
    const recent = this.getRecentReminders(channelId, limit);
    if (recent.length === 0) {
      return '';
    }

    const l = labels[this.language];
    const header =
      this.language === 'ko'
        ? `[시스템 알림: 최근 백그라운드 작업 ${recent.length}건]`
        : `[System Reminders: ${recent.length} recent background tasks]`;

    const entries = recent.map((r) => {
      const status =
        r.type === 'task-completed' || r.type === 'delegation-completed'
          ? '\u2705'
          : r.type === 'task-failed'
            ? '\u274C'
            : r.type === 'task-started'
              ? '\uD83D\uDD04'
              : r.type === 'delegation-started'
                ? '\uD83D\uDD00'
                : '\uD83D\uDCCB';

      let line = `${status} ${r.taskId}: ${r.description} (${l.agent}: ${r.agentId})`;

      if (r.type === 'task-completed' && r.duration !== undefined) {
        line += ` [${formatDuration(r.duration)}]`;
      }
      if (r.type === 'task-failed' && r.error) {
        line += ` [${l.error}: ${r.error}]`;
      }

      return line;
    });

    return [header, ...entries].join('\n');
  }

  /**
   * Destroy the service and clear all state.
   * Flushes pending batches immediately before clearing.
   */
  async destroy(): Promise<void> {
    const flushPromises: Promise<void>[] = [];
    for (const [channelId, pending] of this.pendingBatches.entries()) {
      clearTimeout(pending.timer);
      if (pending.reminders.length > 0) {
        const message = this.formatBatchMessage(pending.reminders);
        flushPromises.push(this.sendToAllCallbacks(channelId, message));
      }
    }
    await Promise.all(flushPromises);

    this.pendingBatches.clear();
    this.channelReminders.clear();
    this.callbacks.clear();
    console.log('[SystemReminder] Service destroyed');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Store a reminder in the per-channel history ring buffer
   */
  private storeReminder(reminder: SystemReminder): void {
    let reminders = this.channelReminders.get(reminder.channelId);
    if (!reminders) {
      reminders = [];
      this.channelReminders.set(reminder.channelId, reminders);
    }

    reminders.push(reminder);

    if (reminders.length > MAX_REMINDERS_PER_CHANNEL) {
      reminders.shift();
    }
  }

  /**
   * Add a completed/failed reminder to the batch queue for its channel.
   * Starts or extends the batch window timer.
   */
  private addToBatch(reminder: SystemReminder): void {
    const { channelId } = reminder;
    let batch = this.pendingBatches.get(channelId);

    if (!batch) {
      batch = {
        reminders: [],
        timer: setTimeout(() => {
          void this.flushBatch(channelId);
        }, this.batchWindowMs),
      };
      this.pendingBatches.set(channelId, batch);
    }

    batch.reminders.push(reminder);

    if (batch.reminders.length >= this.maxBatchSize) {
      clearTimeout(batch.timer);
      void this.flushBatch(channelId);
    }
  }

  /**
   * Flush the pending batch for a channel, sending a combined message
   */
  private async flushBatch(channelId: string): Promise<void> {
    const batch = this.pendingBatches.get(channelId);
    if (!batch || batch.reminders.length === 0) {
      this.pendingBatches.delete(channelId);
      return;
    }

    const reminders = batch.reminders;
    this.pendingBatches.delete(channelId);

    const message = this.formatBatchMessage(reminders);
    await this.sendToAllCallbacks(channelId, message);
  }

  /**
   * Send a message to all registered platform callbacks
   */
  private async sendToAllCallbacks(channelId: string, message: string): Promise<void> {
    if (message.length === 0) {
      return;
    }

    const promises: Promise<void>[] = [];
    for (const [source, callback] of this.callbacks.entries()) {
      promises.push(
        callback(channelId, message, source).catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[SystemReminder] Failed to send ${source} notification: ${errorMessage}`);
        })
      );
    }
    await Promise.all(promises);
  }

  /**
   * Enforce Discord character limit
   */
  private enforceLimit(message: string): string {
    return truncate(message, DISCORD_MESSAGE_LIMIT);
  }
}
