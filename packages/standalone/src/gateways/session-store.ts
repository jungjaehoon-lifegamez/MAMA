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
  private maxResponseLength: number;

  constructor(
    db: Database.Database,
    options: { maxTurns?: number; maxResponseLength?: number } = {}
  ) {
    this.db = db;
    this.maxTurns = options.maxTurns ?? 50; // Extended from 10 to 50 for better conversation continuity
    this.maxResponseLength = options.maxResponseLength ?? 500; // Extended from 200 to 500
    this.runMigration();
  }

  /**
   * Run database migration
   */
  private runMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messenger_sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT,
        context TEXT,
        created_at INTEGER,
        last_active INTEGER,
        UNIQUE(source, channel_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messenger_source_channel
        ON messenger_sessions(source, channel_id);
    `);
  }

  /**
   * Get existing session or create new one
   */
  getOrCreate(source: MessageSource, channelId: string, userId?: string): Session {
    const existing = this.db
      .prepare(
        `
      SELECT * FROM messenger_sessions
      WHERE source = ? AND channel_id = ?
    `
      )
      .get(source, channelId) as SessionRow | undefined;

    if (existing) {
      return this.rowToSession(existing);
    }

    // Create new session
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO messenger_sessions (id, source, channel_id, user_id, context, created_at, last_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(id, source, channelId, userId || null, '[]', now, now);

    return {
      id,
      source,
      channelId,
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

    // Add new turn
    history.push({
      user: userMessage,
      bot: this.truncate(botResponse, this.maxResponseLength),
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
   * Get conversation history for a session
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
   */
  formatContextForPrompt(sessionId: string): string {
    const history = this.getHistory(sessionId);

    if (history.length === 0) {
      return 'New conversation';
    }

    return history.map((turn) => `User: ${turn.user}\nAssistant: ${turn.bot}`).join('\n\n');
  }

  /**
   * Convert database row to Session object
   */
  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      source: row.source as MessageSource,
      channelId: row.channel_id,
      userId: row.user_id || undefined,
      context: row.context || '[]',
      createdAt: row.created_at,
      lastActive: row.last_active,
    };
  }

  /**
   * Truncate text to specified length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
