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
 * - SQLite backup for persistence across restarts (Sprint 3 F5)
 */

import Database from 'better-sqlite3';
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
  /** Optional SQLite database for persistence */
  db?: Database.Database;
  /** Messages to preload from DB on startup per channel (default: 5) */
  preloadLimit?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_PRELOAD_LIMIT = 5; // Preload 5 recent messages per channel
const DB_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours (DB retention)

/**
 * Channel History Manager
 *
 * Manages per-channel message history in memory with SQLite backup.
 */
export class ChannelHistory {
  private histories: Map<string, HistoryEntry[]> = new Map();
  private config: Required<Omit<ChannelHistoryConfig, 'db'>>;
  private db?: Database.Database;
  private preloadLimit: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: ChannelHistoryConfig = {}) {
    this.config = {
      limit: config.limit ?? DEFAULT_LIMIT,
      maxAgeMs: config.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      preloadLimit: config.preloadLimit ?? DEFAULT_PRELOAD_LIMIT,
    };
    this.db = config.db;
    this.preloadLimit = config.preloadLimit ?? DEFAULT_PRELOAD_LIMIT;

    if (this.db) {
      this.runMigration();
      this.loadFromDb();
      this.startCleanupTimer();
    }
  }

  /**
   * Run database migration (create table if not exists)
   */
  private runMigration(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL,
        user_id TEXT NOT NULL,
        body TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_bot INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_channel_ts
        ON channel_messages(channel_id, timestamp DESC);
    `);
  }

  /**
   * Load recent messages from SQLite on startup
   */
  private loadFromDb(): void {
    if (!this.db) return;

    // Get all unique channels
    const channelStmt = this.db.prepare(`
      SELECT DISTINCT channel_id FROM channel_messages
    `);
    const channels = channelStmt.all() as Array<{ channel_id: string }>;

    // Load most recent messages for each channel
    const loadStmt = this.db.prepare(`
      SELECT
        message_id,
        sender,
        user_id,
        body,
        timestamp,
        is_bot
      FROM channel_messages
      WHERE channel_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    for (const { channel_id } of channels) {
      const rows = loadStmt.all(channel_id, this.preloadLimit) as Array<{
        message_id: string;
        sender: string;
        user_id: string;
        body: string;
        timestamp: number;
        is_bot: number;
      }>;

      // Reverse to chronological order (oldest first)
      const entries: HistoryEntry[] = rows.reverse().map((row) => ({
        messageId: row.message_id,
        sender: row.sender,
        userId: row.user_id,
        body: row.body,
        timestamp: row.timestamp,
        isBot: row.is_bot === 1,
        // Attachments not persisted in DB (too complex for now)
      }));

      if (entries.length > 0) {
        this.histories.set(channel_id, entries);
      }
    }
  }

  /**
   * Start periodic cleanup of old messages (every 1 hour)
   */
  private startCleanupTimer(): void {
    if (!this.db) return;

    const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

    this.cleanupInterval = setInterval(() => {
      this.cleanupDb();
    }, CLEANUP_INTERVAL);

    // Cleanup immediately on start
    this.cleanupDb();
  }

  /**
   * Cleanup messages older than 24 hours from SQLite
   */
  private cleanupDb(): void {
    if (!this.db) return;

    const cutoff = Date.now() - DB_MAX_AGE_MS;

    const stmt = this.db.prepare(`
      DELETE FROM channel_messages
      WHERE timestamp < ?
    `);

    const result = stmt.run(cutoff);
    if (result.changes > 0) {
      console.log(`[ChannelHistory] Cleaned up ${result.changes} old messages from DB`);
    }
  }

  /**
   * Record a message to channel history (in-memory + DB)
   */
  record(channelId: string, entry: HistoryEntry): void {
    let history = this.histories.get(channelId);

    if (!history) {
      history = [];
      this.histories.set(channelId, history);
    }

    // Add entry to in-memory
    history.push(entry);

    // FIFO: Remove oldest if over limit
    while (history.length > this.config.limit) {
      history.shift();
    }

    // Write-through to SQLite
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO channel_messages
            (channel_id, message_id, sender, user_id, body, timestamp, is_bot)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          channelId,
          entry.messageId,
          entry.sender,
          entry.userId,
          entry.body,
          entry.timestamp,
          entry.isBot ? 1 : 0
        );
      } catch (err) {
        console.error('[ChannelHistory] Failed to save to DB:', err);
      }
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
  formatForContext(channelId: string, excludeMessageId?: string, keepBotSender?: string): string {
    let history = this.getRecentHistory(channelId, excludeMessageId);

    if (keepBotSender) {
      // Keep human messages + bot messages from the specified sender only.
      // Excludes other bots (DevBot, Reviewer etc.) to avoid context pollution.
      history = history.filter((entry) => !entry.isBot || entry.sender === keepBotSender);
    }

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
   * Cleanup resources (stop timers)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
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
 *
 * @param config - Optional config for first initialization
 */
export function getChannelHistory(config?: ChannelHistoryConfig): ChannelHistory {
  if (!globalChannelHistory) {
    globalChannelHistory = new ChannelHistory(config);
  }
  return globalChannelHistory;
}

/**
 * Set global channel history instance (for testing)
 */
export function setChannelHistory(history: ChannelHistory): void {
  globalChannelHistory = history;
}

/**
 * Initialize global channel history with SQLite database
 *
 * Should be called once at startup before any gateway initialization.
 */
export function initChannelHistory(
  db: Database.Database,
  config?: ChannelHistoryConfig
): ChannelHistory {
  if (globalChannelHistory) {
    globalChannelHistory.destroy();
  }
  globalChannelHistory = new ChannelHistory({ ...config, db });
  return globalChannelHistory;
}
