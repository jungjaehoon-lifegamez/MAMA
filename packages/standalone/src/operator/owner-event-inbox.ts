/**
 * Durable MAMA owner-event inbox.
 *
 * Written BEFORE the delta cursor commits. A crash between enqueue and commit
 * redelivers on the next drain, and per-event dedupe makes that a no-op.
 *
 * Claims are leases, not transfers: an acked row is done; an unacked claim
 * older than the lease returns to pending via replayStale().
 *
 * `eventIds` and `lines` are INDEPENDENT fields, never zipped positionally:
 * eventIds is the identity/cause set (the whole batch), lines is the bounded
 * display excerpt. Trigger activations are immutable procedure snapshots.
 */
import type { SQLiteDatabase } from '../sqlite.js';
import type { TriggerProcedureStep } from './trigger-types.js';

const MAX_ATTEMPTS = 5;
const ACKED_RETENTION_MS = 7 * 86_400_000;
/**
 * Pending rows older than this park as dead so a long provider outage cannot
 * replay months of stale chat. Dead rows remain visible in depth().
 */
const PENDING_RETENTION_MS = 7 * 86_400_000;
/**
 * Dedupe horizon. Event ids must outlive their batch rows or a redelivery
 * after batch pruning re-processes old events - but they cannot live forever
 * either (one TEXT-PK row per event ever drained; review measured 30k+ rows
 * in a single connector incident). 30 days is far wider than any redelivery
 * gap the delta cursor can produce.
 */
const EVENT_RETENTION_MS = 30 * 86_400_000;
const SEEN_CHUNK = 500; // stay under SQLITE_MAX_VARIABLE_NUMBER

export interface InboxBatch {
  channelKey: string;
  /** Identity + cause: EVERY event in the batch. */
  eventIds: string[];
  /** Bounded human-readable excerpt - display only, not paired with eventIds. */
  lines: string[];
  /** Immutable trigger contracts matched before the source cursor advanced. */
  activations: OwnerEventActivation[];
}

export interface OwnerEventActivation {
  triggerId: string;
  kind: string;
  memoryQuery: string;
  procedure: TriggerProcedureStep[];
  requiredEvidence: string[];
}

export interface InboxRow extends InboxBatch {
  id: number;
  status: 'pending' | 'claimed' | 'acked' | 'dead';
  attempts: number;
}

export type OwnerEventBatch = InboxRow;

interface StoredOwnerEventRow {
  id: number;
  channel_key: string;
  event_ids_json: string;
  lines_json: string;
  activations_json: string;
  attempts: number;
}

function deadBatch(row: StoredOwnerEventRow, attempts: number): OwnerEventBatch {
  return {
    id: row.id,
    channelKey: row.channel_key,
    eventIds: JSON.parse(row.event_ids_json) as string[],
    lines: JSON.parse(row.lines_json) as string[],
    activations: JSON.parse(row.activations_json) as OwnerEventActivation[],
    status: 'dead',
    attempts,
  };
}

export class OwnerEventInbox {
  private readonly stmtInsertEvent;
  private readonly stmtInsertBatch;
  private readonly stmtClaimSelect;
  private readonly stmtClaimUpdate;
  private readonly stmtAck;
  private readonly stmtRetry;
  private readonly stmtRetryStatus;
  private readonly stmtPruneAcked;
  private readonly stmtPrunePending;
  private readonly stmtPruneEvents;
  private readonly stmtReplay;
  private readonly stmtDepth;

  constructor(
    private readonly db: SQLiteDatabase,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_event_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_key TEXT NOT NULL,
        event_ids_json TEXT NOT NULL,
        lines_json TEXT NOT NULL,
        activations_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','claimed','acked','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        acked_at INTEGER,
        retry_after INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_owner_event_inbox_status
        ON owner_event_inbox(status, id);
      CREATE TABLE IF NOT EXISTS owner_event_inbox_events (
        event_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_owner_event_inbox_events_seen
        ON owner_event_inbox_events(seen_at);
    `);
    const columns = this.db.prepare(`PRAGMA table_info(owner_event_inbox)`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'retry_after')) {
      this.db.exec(`ALTER TABLE owner_event_inbox ADD COLUMN retry_after INTEGER`);
    }
    // Prepared once: enqueue runs per channel per drain tick and re-preparing
    // statements per call was measurable on backfill drains.
    this.stmtInsertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO owner_event_inbox_events (event_id, seen_at) VALUES (?, ?)`
    );
    this.stmtInsertBatch = this.db.prepare(
      `INSERT INTO owner_event_inbox
         (channel_key, event_ids_json, lines_json, activations_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.stmtClaimSelect = this.db.prepare(
      `SELECT id, channel_key, event_ids_json, lines_json, activations_json, attempts
         FROM owner_event_inbox
        WHERE status = 'pending' AND COALESCE(retry_after, 0) <= ?
        ORDER BY id ASC LIMIT 1`
    );
    this.stmtClaimUpdate = this.db.prepare(
      `UPDATE owner_event_inbox SET status = 'claimed', claimed_at = ?
        WHERE id = ? AND status = 'pending'`
    );
    this.stmtAck = this.db.prepare(
      `UPDATE owner_event_inbox SET status = 'acked', acked_at = ? WHERE id = ?`
    );
    this.stmtRetry = this.db.prepare(
      `UPDATE owner_event_inbox
          SET status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'pending' END,
              attempts = attempts + 1, last_error = ?, claimed_at = NULL,
              retry_after = ? + CASE attempts
                WHEN 0 THEN 60000
                WHEN 1 THEN 300000
                WHEN 2 THEN 1800000
                WHEN 3 THEN 7200000
                ELSE 43200000
              END
        WHERE id = ? AND status = 'claimed'`
    );
    this.stmtRetryStatus = this.db.prepare(`SELECT status FROM owner_event_inbox WHERE id = ?`);
    this.stmtPruneAcked = this.db.prepare(
      `DELETE FROM owner_event_inbox WHERE status = 'acked' AND acked_at <= ?`
    );
    this.stmtPrunePending = this.db.prepare(
      `UPDATE owner_event_inbox
          SET status = 'dead', last_error = 'stale_pending_expired'
        WHERE status = 'pending' AND created_at <= ?`
    );
    this.stmtPruneEvents = this.db.prepare(
      `DELETE FROM owner_event_inbox_events WHERE seen_at <= ?`
    );
    // Same poison cap as retry(): a claim that expires its lease repeatedly
    // (hung run, daemon death mid-flight) must park as dead too, not re-pend
    // forever at the head of the queue (review F8).
    this.stmtReplay = this.db.prepare(
      `UPDATE owner_event_inbox
          SET status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'pending' END,
              attempts = attempts + 1, claimed_at = NULL,
              retry_after = ? + CASE attempts
                WHEN 0 THEN 60000
                WHEN 1 THEN 300000
                WHEN 2 THEN 1800000
                WHEN 3 THEN 7200000
                ELSE 43200000
              END
        WHERE status = 'claimed' AND COALESCE(claimed_at, 0) <= ?`
    );
    // Grouped on the (status, id) index; never scans the acked bulk.
    this.stmtDepth = this.db.prepare(
      `SELECT status, COUNT(*) AS n FROM owner_event_inbox
        WHERE status IN ('pending','claimed','dead') GROUP BY status`
    );
  }

  private now(): number {
    return this.clock();
  }

  /**
   * Dedupe is PER EVENT, not per batch shape. A batch-boundary key fails on
   * partial redelivery: [e1] enqueues, the cursor commit fails elsewhere, the
   * next drain delivers [e1,e2] under a different boundary - and e1 runs
   * twice. Seen event ids live in their own table; a batch with no unseen
   * events is dropped, a batch with any unseen event is stored whole (its
   * display lines may briefly re-show an already-seen event; identity never
   * lies).
   */
  enqueue(batch: InboxBatch): number | null {
    const seenIds = new Set<string>();
    for (let i = 0; i < batch.eventIds.length; i += SEEN_CHUNK) {
      const chunk = batch.eventIds.slice(i, i + SEEN_CHUNK);
      const rows = this.db
        .prepare(
          `SELECT event_id FROM owner_event_inbox_events WHERE event_id IN (${chunk
            .map(() => '?')
            .join(',')})`
        )
        .all(...chunk) as Array<{ event_id: string }>;
      for (const row of rows) seenIds.add(row.event_id);
    }
    const fresh = batch.eventIds.filter((id) => !seenIds.has(id));
    if (fresh.length === 0) {
      return null; // fully redelivered - already durable
    }

    const run = this.db.transaction(() => {
      const now = this.now();
      for (const id of fresh) this.stmtInsertEvent.run(id, now);
      return this.stmtInsertBatch.run(
        batch.channelKey,
        JSON.stringify(fresh),
        JSON.stringify(batch.lines),
        JSON.stringify(batch.activations),
        now
      );
    });
    return Number(run().lastInsertRowid);
  }

  claimNext(): InboxRow | null {
    const row = this.stmtClaimSelect.get(this.now()) as
      | {
          id: number;
          channel_key: string;
          event_ids_json: string;
          lines_json: string;
          activations_json: string;
          attempts: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const claimed = this.stmtClaimUpdate.run(this.now(), row.id);
    if (claimed.changes !== 1) {
      return null; // lost a race; caller just tries again next tick
    }
    return {
      id: row.id,
      channelKey: row.channel_key,
      eventIds: JSON.parse(row.event_ids_json) as string[],
      lines: JSON.parse(row.lines_json) as string[],
      activations: JSON.parse(row.activations_json) as OwnerEventActivation[],
      status: 'claimed',
      attempts: row.attempts,
    };
  }

  ack(id: number): void {
    this.stmtAck.run(this.now(), id);
  }

  /**
   * Return a claim to pending, or park it dead after MAX_ATTEMPTS. Returns
   * the resulting status so the caller can be LOUD about a dead batch - a
   * permanent loss must never be silent.
   */
  retry(id: number, error: string): 'pending' | 'dead' | 'noop' {
    const result = this.stmtRetry.run(error.slice(0, 500), this.now(), id);
    if (result.changes !== 1) {
      return 'noop'; // replayStale already flipped it
    }
    const row = this.stmtRetryStatus.get(id) as { status: string } | undefined;
    return row?.status === 'dead' ? 'dead' : 'pending';
  }

  replayStale(olderThanMs: number, now = this.now()): number {
    return this.replayStaleDetailed(olderThanMs, now).replayed;
  }

  replayStaleDetailed(
    olderThanMs: number,
    now = this.now()
  ): { replayed: number; newlyDead: OwnerEventBatch[] } {
    // Housekeeping rides along: acked rows age out, stale pending rows park
    // as dead (visible, bounded), and the dedupe table keeps a wide but
    // finite horizon - no table here grows without bound.
    const stalePending = this.db
      .prepare(
        `SELECT id, channel_key, event_ids_json, lines_json, activations_json, attempts
           FROM owner_event_inbox
          WHERE status = 'pending' AND created_at <= ?
          ORDER BY id ASC`
      )
      .all(now - PENDING_RETENTION_MS) as StoredOwnerEventRow[];
    this.stmtPruneAcked.run(now - ACKED_RETENTION_MS);
    this.stmtPrunePending.run(now - PENDING_RETENTION_MS);
    this.stmtPruneEvents.run(now - EVENT_RETENTION_MS);
    const cutoff = now - olderThanMs;
    const dying = this.db
      .prepare(
        `SELECT id, channel_key, event_ids_json, lines_json, activations_json, attempts
           FROM owner_event_inbox
          WHERE status = 'claimed' AND attempts + 1 >= ${MAX_ATTEMPTS}
            AND COALESCE(claimed_at, 0) <= ?
          ORDER BY id ASC`
      )
      .all(cutoff) as StoredOwnerEventRow[];
    const result = this.stmtReplay.run(now, cutoff);
    return {
      replayed: result.changes,
      newlyDead: [
        ...stalePending.map((row) => deadBatch(row, row.attempts)),
        ...dying.map((row) => deadBatch(row, row.attempts + 1)),
      ],
    };
  }

  depth(): { pending: number; claimed: number; dead: number } {
    const rows = this.stmtDepth.all() as Array<{ status: string; n: number }>;
    const byStatus = new Map(rows.map((row) => [row.status, row.n]));
    return {
      pending: byStatus.get('pending') ?? 0,
      claimed: byStatus.get('claimed') ?? 0,
      dead: byStatus.get('dead') ?? 0,
    };
  }
}
