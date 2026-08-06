/**
 * Session store for messenger conversations
 *
 * Manages conversation sessions with rolling context (history)
 * for cross-platform messenger integration.
 */

import type { SQLiteDatabase } from '../sqlite.js';
import { createHash, randomUUID } from 'crypto';
import type { Session, MessageSource, ConversationTurn } from './types.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('SessionStore');
const USER_CONTEXT_HEAD_CHARS = 300;
const MEDIA_CONTEXT_TAIL_CHARS = 1_200;
const HOST_VERIFIED_MEDIA_MARKER = '\n\nHost-verified uploaded ';

function truncateUserContext(content: string): string {
  const mediaMarker = content.lastIndexOf(HOST_VERIFIED_MEDIA_MARKER);
  if (mediaMarker < 0) {
    return content.length > USER_CONTEXT_HEAD_CHARS
      ? `${content.slice(0, USER_CONTEXT_HEAD_CHARS)}...`
      : content;
  }

  const head = content.slice(0, mediaMarker);
  const media = content.slice(mediaMarker + 2);
  const boundedHead =
    head.length > USER_CONTEXT_HEAD_CHARS ? `${head.slice(0, USER_CONTEXT_HEAD_CHARS)}...` : head;
  const boundedMedia =
    media.length > MEDIA_CONTEXT_TAIL_CHARS
      ? `${media.slice(0, MEDIA_CONTEXT_TAIL_CHARS)}...`
      : media;
  return `${boundedHead}\n\n${boundedMedia}`;
}

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
  private db: SQLiteDatabase;
  private maxTurns: number;

  constructor(db: SQLiteDatabase, options: { maxTurns?: number } = {}) {
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
   * Append a single message (user or assistant) to session history.
   * - role='user': creates a new turn with empty bot
   * - role='assistant': fills bot field of last incomplete turn, or creates new turn
   */
  appendMessage(
    sessionId: string,
    msg: { role: 'user' | 'assistant'; content: string; timestamp: number },
    opts: { sourceMessageRef?: string } = {}
  ): boolean {
    const session = this.getById(sessionId);
    if (!session) {
      return false;
    }

    let history: ConversationTurn[];
    try {
      history = JSON.parse(session.context || '[]');
    } catch {
      history = [];
    }

    if (msg.role === 'user') {
      history.push({
        user: msg.content,
        bot: '',
        timestamp: msg.timestamp,
        // TG-05: a source-ref-bound turn stays provisional until the atomic
        // turn/receipt commit; fresh-session formatting excludes it.
        ...(opts.sourceMessageRef
          ? { sourceMessageRef: opts.sourceMessageRef, state: 'provisional' as const }
          : {}),
      });
    } else {
      const lastTurn = history[history.length - 1];
      if (lastTurn && lastTurn.bot === '') {
        lastTurn.bot = msg.content;
        lastTurn.timestamp = msg.timestamp;
      } else {
        logger.warn(`Creating orphan assistant message for session ${sessionId}`);
        history.push({ user: '', bot: msg.content, timestamp: msg.timestamp });
      }
    }

    const recentHistory = history.slice(-this.maxTurns);

    const result = this.db
      .prepare('UPDATE messenger_sessions SET context = ?, last_active = ? WHERE id = ?')
      .run(JSON.stringify(recentHistory), Date.now(), sessionId);

    return result.changes > 0;
  }

  /**
   * Flush streaming response to the last incomplete turn.
   * Called periodically during streaming to persist partial assistant responses.
   */
  flushStreamingResponse(sessionId: string, accumulatedText: string): boolean {
    const session = this.getById(sessionId);
    if (!session) {
      return false;
    }

    let history: ConversationTurn[];
    try {
      history = JSON.parse(session.context || '[]');
    } catch {
      history = [];
    }

    const lastTurn = history[history.length - 1];
    if (!lastTurn) {
      return false;
    }

    // Update the bot field with accumulated streaming text
    lastTurn.bot = accumulatedText;
    lastTurn.timestamp = Date.now();

    const result = this.db
      .prepare('UPDATE messenger_sessions SET context = ?, last_active = ? WHERE id = ?')
      .run(JSON.stringify(history), Date.now(), sessionId);

    return result.changes > 0;
  }

  /** Remove the most recent uncommitted turn after an agent failure. */
  discardIncompleteTurn(sessionId: string): boolean {
    const session = this.getById(sessionId);
    if (!session) {
      return false;
    }
    let history: ConversationTurn[];
    try {
      history = JSON.parse(session.context || '[]');
    } catch {
      history = [];
    }
    if (history.length === 0) {
      return false;
    }
    history.pop();
    const result = this.db
      .prepare('UPDATE messenger_sessions SET context = ?, last_active = ? WHERE id = ?')
      .run(JSON.stringify(history), Date.now(), sessionId);
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
  /**
   * TG-05 (design Decision 6): finalize the exact provisional turn, insert its
   * report-consumption receipt, and mark the selected delivered events
   * consumed - in ONE SQLite transaction on the shared connection. An exact
   * replay is a no-op; any divergence is a conflict. A crash before the
   * transaction leaves the turn provisional and events pending; a crash after
   * it leaves both final and consumed.
   */
  finalizeTurnWithReportReceipt(input: {
    sessionId: string;
    sourceMessageRef: string;
    finalResponse: string;
    committedAtIso: string;
    receipt: {
      deliveryIds: string[];
      projectionVersion: string;
      projectionText: string;
      projectionHash: string;
    };
  }): void {
    if (input.receipt.deliveryIds.length === 0) {
      throw new Error('A report receipt requires at least one selected delivery ID');
    }
    const responseSha = createHash('sha256').update(input.finalResponse, 'utf8').digest('hex');

    const run = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT delivery_ids, projection_hash, final_response_sha256
           FROM telegram_report_context_receipts WHERE source_message_ref = ?`
        )
        .get(input.sourceMessageRef) as
        | { delivery_ids: string; projection_hash: string; final_response_sha256: string }
        | undefined;
      if (existing) {
        if (
          existing.delivery_ids === JSON.stringify(input.receipt.deliveryIds) &&
          existing.projection_hash === input.receipt.projectionHash &&
          existing.final_response_sha256 === responseSha
        ) {
          return; // exact replay converges
        }
        throw new Error(
          `Report receipt conflict for ${input.sourceMessageRef}: a different finalization is already committed`
        );
      }

      const session = this.getById(input.sessionId);
      if (!session) {
        throw new Error(`Unknown session ${input.sessionId}`);
      }
      let history: ConversationTurn[];
      try {
        history = JSON.parse(session.context || '[]');
      } catch {
        history = [];
      }
      const turn = history.find(
        (candidate) =>
          candidate.sourceMessageRef === input.sourceMessageRef && candidate.state === 'provisional'
      );
      if (!turn) {
        throw new Error(
          `No provisional turn matches ${input.sourceMessageRef} in session ${input.sessionId}`
        );
      }
      turn.bot = input.finalResponse;
      turn.state = 'final';
      turn.finalResponseSha256 = responseSha;
      this.db
        .prepare('UPDATE messenger_sessions SET context = ?, last_active = ? WHERE id = ?')
        .run(JSON.stringify(history.slice(-this.maxTurns)), Date.now(), input.sessionId);

      this.db
        .prepare(
          `INSERT INTO telegram_report_context_receipts
             (source_message_ref, session_id, delivery_ids, projection_version,
              projection_text, projection_hash, final_response_sha256, committed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.sourceMessageRef,
          input.sessionId,
          JSON.stringify(input.receipt.deliveryIds),
          input.receipt.projectionVersion,
          input.receipt.projectionText,
          input.receipt.projectionHash,
          responseSha,
          input.committedAtIso
        );

      const consume = this.db.prepare(
        `UPDATE telegram_report_context_events
         SET disposition = 'consumed_turn', consumed_by_ref = ?, consumed_at = ?
         WHERE delivery_id = ? AND state = 'delivered' AND disposition = 'pending'`
      );
      for (const deliveryId of input.receipt.deliveryIds) {
        consume.run(input.sourceMessageRef, input.committedAtIso, deliveryId);
      }
    });
    run();
  }

  formatContextForPrompt(sessionId: string, maxTurnsToInject: number = 5): string {
    // TG-05: provisional turns are uncommitted - a fresh session must never
    // restore them. Legacy turns without a state are final.
    const history = this.getHistory(sessionId).filter((turn) => turn.state !== 'provisional');

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
        const userMsg = truncateUserContext(turn.user);
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
