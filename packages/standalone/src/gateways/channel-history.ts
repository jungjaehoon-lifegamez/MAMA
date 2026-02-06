/**
 * Channel History Manager
 *
 * In-memory storage of recent messages per channel, similar to OpenClaw's
 * guildHistories map. Stores message history with attachments for context
 * injection and skill matching.
 *
 * Features:
 * - FIFO ring buffer with configurable limit
 * - Attachment references preserved
 * - History formatting for Claude context
 * - Automatic cleanup of old entries
 */

import type { MessageAttachment } from './types.js';

/**
 * Single history entry
 */
export interface HistoryEntry {
  /** Message ID */
  messageId: string;
  /** Author username */
  sender: string;
  /** Author user ID */
  userId: string;
  /** Message text content */
  body: string;
  /** Timestamp */
  timestamp: number;
  /** Attached files */
  attachments?: MessageAttachment[];
  /** Whether this is a bot message */
  isBot?: boolean;
}

/**
 * Channel history configuration
 */
export interface ChannelHistoryConfig {
  /** Maximum messages to keep per channel (default: 20) */
  limit?: number;
  /** Maximum age in ms before auto-cleanup (default: 10 minutes) */
  maxAgeMs?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Channel History Manager
 *
 * Manages per-channel message history in memory.
 */
export class ChannelHistory {
  private histories: Map<string, HistoryEntry[]> = new Map();
  private config: Required<ChannelHistoryConfig>;

  constructor(config: ChannelHistoryConfig = {}) {
    this.config = {
      limit: config.limit ?? DEFAULT_LIMIT,
      maxAgeMs: config.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    };
  }

  /**
   * Record a message to channel history
   */
  record(channelId: string, entry: HistoryEntry): void {
    let history = this.histories.get(channelId);

    if (!history) {
      history = [];
      this.histories.set(channelId, history);
    }

    // Add entry
    history.push(entry);

    // FIFO: Remove oldest if over limit
    while (history.length > this.config.limit) {
      history.shift();
    }
  }

  /**
   * Get history for a channel
   */
  getHistory(channelId: string): HistoryEntry[] {
    const history = this.histories.get(channelId) || [];
    const cutoff = Date.now() - this.config.maxAgeMs;

    // Filter out old entries
    return history.filter((entry) => entry.timestamp > cutoff);
  }

  /**
   * Get recent history excluding the current message
   */
  getRecentHistory(channelId: string, excludeMessageId?: string): HistoryEntry[] {
    return this.getHistory(channelId).filter((entry) => entry.messageId !== excludeMessageId);
  }

  /**
   * Get recent attachments from history (for skill matching)
   */
  getRecentAttachments(channelId: string, userId?: string): MessageAttachment[] {
    const history = this.getHistory(channelId);
    const attachments: MessageAttachment[] = [];

    // Look for attachments from same user in recent history
    for (const entry of history.slice().reverse()) {
      // Only consider attachments from same user (if specified)
      if (userId && entry.userId !== userId) continue;

      if (entry.attachments && entry.attachments.length > 0) {
        attachments.push(...entry.attachments);
        // Only get attachments from most recent message with attachments
        break;
      }
    }

    return attachments;
  }

  /**
   * Format history for Claude context injection
   * Similar to OpenClaw's "[Chat messages since your last reply - for context]"
   */
  formatForContext(channelId: string, excludeMessageId?: string): string {
    const history = this.getRecentHistory(channelId, excludeMessageId);

    if (history.length === 0) {
      return '';
    }

    const lines = history.map((entry) => {
      let line = `- ${entry.sender}: ${entry.body}`;

      // Add attachment indicators
      if (entry.attachments && entry.attachments.length > 0) {
        const imageCount = entry.attachments.filter((a) => a.type === 'image').length;
        const fileCount = entry.attachments.filter((a) => a.type === 'file').length;

        if (imageCount > 0) {
          line += ` <media:image>${imageCount > 1 ? ` (${imageCount} images)` : ''}`;
        }
        if (fileCount > 0) {
          line += ` <media:document>${fileCount > 1 ? ` (${fileCount} files)` : ''}`;
        }
      }

      return line;
    });

    return `[Chat messages since your last reply - for context]
${lines.join('\n')}`;
  }

  /**
   * Update the sender name of a specific history entry.
   * Safe encapsulated method that avoids direct array mutation from outside.
   */
  updateSender(channelId: string, messageId: string, newSender: string): boolean {
    const history = this.histories.get(channelId);
    if (!history) return false;

    const entry = history.find((e) => e.messageId === messageId);
    if (!entry) return false;

    entry.sender = newSender;
    return true;
  }

  /**
   * Clear history for a channel (after bot reply, like OpenClaw)
   */
  clear(channelId: string): void {
    this.histories.delete(channelId);
  }

  /**
   * Clear attachments from history while keeping text for conversation context
   */
  clearAttachments(channelId: string): void {
    const history = this.histories.get(channelId);
    if (!history) return;

    for (const entry of history) {
      delete entry.attachments;
    }
  }

  /**
   * Clear all histories
   */
  clearAll(): void {
    this.histories.clear();
  }

  /**
   * Get all channel IDs with history
   */
  getChannelIds(): string[] {
    return Array.from(this.histories.keys());
  }

  /**
   * Cleanup old entries across all channels
   */
  cleanup(): number {
    const cutoff = Date.now() - this.config.maxAgeMs;
    let cleaned = 0;

    for (const [channelId, history] of this.histories.entries()) {
      const before = history.length;
      const filtered = history.filter((entry) => entry.timestamp > cutoff);

      if (filtered.length === 0) {
        this.histories.delete(channelId);
      } else if (filtered.length !== before) {
        this.histories.set(channelId, filtered);
      }

      cleaned += before - filtered.length;
    }

    return cleaned;
  }
}

/**
 * Global channel history instance
 */
let globalChannelHistory: ChannelHistory | null = null;

/**
 * Get global channel history instance
 */
export function getChannelHistory(): ChannelHistory {
  if (!globalChannelHistory) {
    globalChannelHistory = new ChannelHistory();
  }
  return globalChannelHistory;
}

/**
 * Set global channel history instance (for testing)
 */
export function setChannelHistory(history: ChannelHistory): void {
  globalChannelHistory = history;
}
