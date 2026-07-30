/**
 * Durable conductor inbox.
 *
 * Written BEFORE the delta cursor commits (the trigger loop today commits the
 * cursor and then invokes its callback, so a callback failure loses the batch
 * forever - operator-trigger-loop.ts, "feed AFTER commit"). With this table
 * the order inverts: enqueue -> commit. A crash between the two redelivers on
 * the next drain, and per-event dedupe turns redelivery into a no-op.
 *
 * Claims are leases, not transfers: an acked row is done; an unacked claim
 * older than the lease returns to pending via replayStale().
 */
import type { SQLiteDatabase } from '../sqlite.js';

export interface InboxBatch {
  channelKey: string;
  eventIds: string[];
  lines: string[];
}

export interface InboxRow extends InboxBatch {
  id: number;
  status: 'pending' | 'claimed' | 'acked' | 'dead';
  attempts: number;
}

export class ConductorInbox {
  constructor(private readonly db: SQLiteDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conductor_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_key TEXT NOT NULL,
        event_ids_json TEXT NOT NULL,
        lines_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','claimed','acked','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        acked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_conductor_inbox_status
        ON conductor_inbox(status, id);
      CREATE TABLE IF NOT EXISTS conductor_inbox_events (
        event_id TEXT PRIMARY KEY
      );
    `);
  }

  private now(): number {
    return Date.now();
  }

  /**
   * Dedupe is PER EVENT, not per batch shape. A batch-boundary key fails on
   * partial redelivery: [e1] enqueues, the cursor commit fails elsewhere, the
   * next drain delivers [e1,e2] under a different boundary - and e1 runs
   * twice. Seen event ids are recorded in their own table; enqueue keeps only
   * the unseen slice of the batch.
   */
  enqueue(batch: InboxBatch): number | null {
    const seen = this.db.prepare(`SELECT 1 FROM conductor_inbox_events WHERE event_id = ?`);
    const fresh: { id: string; line: string }[] = [];
    batch.eventIds.forEach((id, i) => {
      if (!seen.get(id)) fresh.push({ id, line: batch.lines[i] ?? '' });
    });
    if (fresh.length === 0) return null; // fully redelivered - already durable

    const insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO conductor_inbox_events (event_id) VALUES (?)`
    );
    const insertBatch = this.db.prepare(
      `INSERT INTO conductor_inbox
         (channel_key, event_ids_json, lines_json, created_at)
       VALUES (?, ?, ?, ?)`
    );
    const run = this.db.transaction(() => {
      for (const f of fresh) insertEvent.run(f.id);
      return insertBatch.run(
        batch.channelKey,
        JSON.stringify(fresh.map((f) => f.id)),
        JSON.stringify(fresh.map((f) => f.line)),
        this.now()
      );
    });
    return Number(run().lastInsertRowid);
  }

  claimNext(): InboxRow | null {
    const row = this.db
      .prepare(
        `SELECT id, channel_key, event_ids_json, lines_json, attempts
           FROM conductor_inbox WHERE status = 'pending' ORDER BY id ASC LIMIT 1`
      )
      .get() as
      | {
          id: number;
          channel_key: string;
          event_ids_json: string;
          lines_json: string;
          attempts: number;
        }
      | undefined;
    if (!row) return null;
    const claimed = this.db
      .prepare(
        `UPDATE conductor_inbox SET status = 'claimed', claimed_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(this.now(), row.id);
    if (claimed.changes !== 1) return null; // lost a race; caller just tries again next tick
    return {
      id: row.id,
      channelKey: row.channel_key,
      eventIds: JSON.parse(row.event_ids_json) as string[],
      lines: JSON.parse(row.lines_json) as string[],
      status: 'claimed',
      attempts: row.attempts,
    };
  }

  ack(id: number): void {
    this.db
      .prepare(`UPDATE conductor_inbox SET status = 'acked', acked_at = ? WHERE id = ?`)
      .run(this.now(), id);
  }

  retry(id: number, error: string): void {
    // A poison batch must not spin forever: after MAX_ATTEMPTS it parks as
    // 'dead' - visible in depth(), loud in the log, never silently retried.
    this.db
      .prepare(
        `UPDATE conductor_inbox
            SET status = CASE WHEN attempts + 1 >= 5 THEN 'dead' ELSE 'pending' END,
                attempts = attempts + 1, last_error = ?, claimed_at = NULL
          WHERE id = ? AND status = 'claimed'`
      )
      .run(error.slice(0, 500), id);
  }

  replayStale(olderThanMs: number, now = this.now()): number {
    // Housekeeping rides along: acked rows older than 7 days leave the table,
    // so the inbox cannot grow without bound.
    this.db
      .prepare(`DELETE FROM conductor_inbox WHERE status = 'acked' AND acked_at <= ?`)
      .run(now - 7 * 86_400_000);
    const result = this.db
      .prepare(
        `UPDATE conductor_inbox
            SET status = 'pending', attempts = attempts + 1, claimed_at = NULL
          WHERE status = 'claimed' AND COALESCE(claimed_at, 0) <= ?`
      )
      .run(now - olderThanMs);
    return result.changes;
  }

  depth(): { pending: number; claimed: number; dead: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(status = 'pending') AS pending, SUM(status = 'claimed') AS claimed,
                SUM(status = 'dead') AS dead
           FROM conductor_inbox`
      )
      .get() as { pending: number | null; claimed: number | null; dead: number | null };
    return { pending: row.pending ?? 0, claimed: row.claimed ?? 0, dead: row.dead ?? 0 };
  }
}
