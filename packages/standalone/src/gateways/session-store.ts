/**
 * Session store for messenger conversations
 *
 * Manages conversation sessions with rolling context (history)
 * for cross-platform messenger integration.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Session, MessageSource, ConversationTurn } from './types.js';

// ============================================================================
// Database row types
// ============================================================================

interface SessionRow {
  id: string;
  source: string;
  channel_id: string;
  channel_name: string | null;
  user_id: string | null;
  context: string | null;
  created_at: number;
  last_active: number;
}

// ============================================================================
// SessionStore Class
// ============================================================================

/**
 * SQLite-backed session store for messenger conversations
 */
export class SessionStore {
  private db: Database.Database;
  private maxTurns: number;

  constructor(db: Database.Database, options: { maxTurns?: number } = {}) {
    this.db = db;
    this.maxTurns = options.maxTurns ?? 1000; // Store unlimited turns in DB
    this.runMigration();
  }

  /**
   * Run database migration
   */
  private runMigration(): void {
    // Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messenger_sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        user_id TEXT,
        context TEXT,
        created_at INTEGER,
        last_active INTEGER,
        UNIQUE(source, channel_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messenger_source_channel
        ON messenger_sessions(source, channel_id);
    `);

    // Add missing columns for older databases
    try {
      const tableInfo = this.db.prepare('PRAGMA table_info(messenger_sessions)').all() as Array<{
        name: string;
      }>;
      const columns = tableInfo.map((col) => col.name);

      if (!columns.includes('created_at')) {
        this.db.exec('ALTER TABLE messenger_sessions ADD COLUMN created_at INTEGER');
      }
      if (!columns.includes('last_active')) {
        this.db.exec('ALTER TABLE messenger_sessions ADD COLUMN last_active INTEGER');
      }
      if (!columns.includes('channel_name')) {
        this.db.exec('ALTER TABLE messenger_sessions ADD COLUMN channel_name TEXT');
      }
    } catch {
      // Ignore errors - columns might already exist
    }
  }

  /**
   * Get existing session or create new one
   */
  getOrCreate(
    source: MessageSource,
    channelId: string,
    userId?: string,
    channelName?: string
  ): Session {
    const existing = this.db
      .prepare(
        `
      SELECT * FROM messenger_sessions
      WHERE source = ? AND channel_id = ?
    `
      )
      .get(source, channelId) as SessionRow | undefined;

    if (existing) {
      // Update channel name if provided and different
      if (channelName && existing.channel_name !== channelName) {
        this.db
          .prepare('UPDATE messenger_sessions SET channel_name = ? WHERE id = ?')
          .run(channelName, existing.id);
        existing.channel_name = channelName;
      }
      return this.rowToSession(existing);
    }

    // Create new session
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO messenger_sessions (id, source, channel_id, channel_name, user_id, context, created_at, last_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(id, source, channelId, channelName || null, userId || null, '[]', now, now);

    return {
      id,
      source,
      channelId,
      channelName,
      userId,
      context: '[]',
      createdAt: now,
      lastActive: now,
    };
  }

  /**
   * Get session by ID
   */
  getById(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM messenger_sessions WHERE id = ?').get(sessionId) as
      | SessionRow
      | undefined;

    return row ? this.rowToSession(row) : null;
  }

  /**
   * Update session with new conversation turn
   */
  updateSession(sessionId: string, userMessage: string, botResponse: string): boolean {
    const session = this.getById(sessionId);
    if (!session) return false;

    // Parse existing context
    let history: ConversationTurn[];
    try {
      history = JSON.parse(session.context || '[]');
    } catch {
      history = [];
    }

    // Add new turn (store full response, truncation only at prompt injection)
    history.push({
      user: userMessage,
      bot: botResponse,
      timestamp: Date.now(),
    });

    // Keep only recent turns
    const recentHistory = history.slice(-this.maxTurns);

    // Update database
    const result = this.db
      .prepare(
        `
      UPDATE messenger_sessions
      SET context = ?, last_active = ?
      WHERE id = ?
    `
      )
      .run(JSON.stringify(recentHistory), Date.now(), sessionId);

    return result.changes > 0;
  }

  /**
   * Get conversation history for a session by ID
   */
  getHistory(sessionId: string): ConversationTurn[] {
    const session = this.getById(sessionId);
    if (!session) return [];

    try {
      return JSON.parse(session.context || '[]');
    } catch {
      return [];
    }
  }

  /**
   * Get conversation history by source and channel
   * Used by WebSocket handler for viewer sessions
   */
  getHistoryByChannel(source: MessageSource, channelId: string): ConversationTurn[] {
    const session = this.db
      .prepare('SELECT context FROM messenger_sessions WHERE source = ? AND channel_id = ?')
      .get(source, channelId) as { context: string | null } | undefined;

    if (!session) return [];

    try {
      return JSON.parse(session.context || '[]');
    } catch {
      return [];
    }
  }

  /**
   * Clear session context (start fresh)
   */
  clearContext(sessionId: string): boolean {
    const result = this.db
      .prepare(
        `
      UPDATE messenger_sessions
      SET context = ?, last_active = ?
      WHERE id = ?
    `
      )
      .run('[]', Date.now(), sessionId);

    return result.changes > 0;
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    const result = this.db.prepare('DELETE FROM messenger_sessions WHERE id = ?').run(sessionId);

    return result.changes > 0;
  }

  /**
   * List all sessions for a source
   */
  listSessions(source?: MessageSource): Session[] {
    let stmt;
    if (source) {
      stmt = this.db.prepare(
        'SELECT * FROM messenger_sessions WHERE source = ? ORDER BY last_active DESC'
      );
      return (stmt.all(source) as SessionRow[]).map((row) => this.rowToSession(row));
    } else {
      stmt = this.db.prepare('SELECT * FROM messenger_sessions ORDER BY last_active DESC');
      return (stmt.all() as SessionRow[]).map((row) => this.rowToSession(row));
    }
  }

  /**
   * Update channel name for a session by source and channel ID
   * Used to backfill channel names when gateway connects
   */
  updateChannelName(source: MessageSource, channelId: string, channelName: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE messenger_sessions SET channel_name = ? WHERE source = ? AND channel_id = ? AND (channel_name IS NULL OR channel_name = '')`
      )
      .run(channelName, source, channelId);

    return result.changes > 0;
  }

  /**
   * Delete inactive sessions older than specified age
   */
  cleanupInactiveSessions(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare('DELETE FROM messenger_sessions WHERE last_active < ?')
      .run(cutoff);

    return result.changes;
  }

  /**
   * Get the most recently active session for a specific source
   */
  getLastActiveSession(source?: MessageSource): Session | null {
    let stmt;
    let row: SessionRow | undefined;

    if (source) {
      stmt = this.db.prepare(
        'SELECT * FROM messenger_sessions WHERE source = ? ORDER BY last_active DESC LIMIT 1'
      );
      row = stmt.get(source) as SessionRow | undefined;
    } else {
      stmt = this.db.prepare('SELECT * FROM messenger_sessions ORDER BY last_active DESC LIMIT 1');
      row = stmt.get() as SessionRow | undefined;
    }

    return row ? this.rowToSession(row) : null;
  }

  /**
   * Format context as readable string for system prompt
   * Only includes the most recent turns to avoid token bloat
   */
  formatContextForPrompt(sessionId: string, maxTurnsToInject: number = 5): string {
    const history = this.getHistory(sessionId);

    if (history.length === 0) {
      return 'New conversation';
    }

    // Only inject the most recent N turns to keep token usage reasonable
    const recentTurns = history.slice(-maxTurnsToInject);

    // Truncate long messages when injecting to save tokens
    // User messages: 300 chars, Bot responses: 500 chars
    // Bot responses are aggressively truncated because they often contain
    // tool_use blocks, verbose metadata (||⏱️ N turns||), and related decisions
    return recentTurns
      .map((turn) => {
        const userMsg = turn.user.length > 300 ? turn.user.slice(0, 300) + '...' : turn.user;
        // Strip tool_use noise and metadata before truncating
        let botMsg = turn.bot
          .replace(/\|\|[^|]*\|\|/g, '') // Remove ||⏱️ N turns|| markers
          .replace(/```tool_call[\s\S]*?```/g, '[tool used]') // Collapse tool_call blocks
          .replace(/## Related decisions[\s\S]*$/m, '') // Remove injected decisions footer
          .trim();
        botMsg = botMsg.length > 500 ? botMsg.slice(0, 500) + '...' : botMsg;
        return `User: ${userMsg}\nAssistant: ${botMsg}`;
      })
      .join('\n\n');
  }

  /**
   * Convert database row to Session object
   */
  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      source: row.source as MessageSource,
      channelId: row.channel_id,
      channelName: row.channel_name || undefined,
      userId: row.user_id || undefined,
      context: row.context || '[]',
      createdAt: row.created_at,
      lastActive: row.last_active,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
