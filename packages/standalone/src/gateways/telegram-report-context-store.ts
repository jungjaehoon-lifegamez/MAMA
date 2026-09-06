/** TG-05/TG-06: durable Telegram owner-report delivery ledger. */

import type { SQLiteDatabase } from '../sqlite.js';

export type ReportContextEventState =
  | 'prepared_retryable'
  | 'prepared_definite_rejection'
  | 'delivered'
  | 'cancelled';

export interface ReportContextTarget {
  source: 'telegram';
  channelId: string;
}

export interface ReportContextReservationInput {
  deliveryId: string;
  target: ReportContextTarget;
  mode: 'digest' | 'full';
  occurrence: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  text: string;
  payloadIdentity: string;
}

export interface ReportContextEvent {
  seq: number;
  deliveryId: string;
  state: ReportContextEventState;
}

export interface ReportContextEventDetail extends ReportContextEvent {
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  rejectionReason: string | null;
  cancelReason: string | null;
}

export interface TelegramReportContextStoreOptions {
  nowIso?: () => string;
  /** Design Decision 5 live capacity (prepared-or-unconsumed) per target. */
  liveRowCapPerTarget?: number;
  liveByteCapPerTarget?: number;
  /** Retained exact-text capacity per target before consumed rows compact. */
  retainedRowCapPerTarget?: number;
  retainedByteCapPerTarget?: number;
}

/** Design Decision 5 initial limits. */
const DEFAULT_LIVE_ROW_CAP = 2_048;
const DEFAULT_LIVE_BYTE_CAP = 64 * 1024 * 1024;
const DEFAULT_RETAINED_ROW_CAP = 8_192;
const DEFAULT_RETAINED_BYTE_CAP = 256 * 1024 * 1024;
const TOMBSTONE_REPLAY_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;
const TOMBSTONE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_TOMBSTONE_CAP = 100_000;

/** Live = prepared or delivered-but-unconsumed (design Decision 5). */
const LIVE_ROW_CONDITION = `(
  state IN ('prepared_retryable', 'prepared_definite_rejection')
  OR (state = 'delivered' AND disposition = 'pending')
)`;

function targetIdentity(target: ReportContextTarget): string {
  return JSON.stringify([target.source, target.channelId]);
}

export class TelegramReportContextStore {
  private readonly nowIso: () => string;
  private readonly liveRowCap: number;
  private readonly liveByteCap: number;
  private readonly retainedRowCap: number;
  private readonly retainedByteCap: number;

  constructor(
    private readonly db: SQLiteDatabase,
    options: TelegramReportContextStoreOptions = {}
  ) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.liveRowCap = options.liveRowCapPerTarget ?? DEFAULT_LIVE_ROW_CAP;
    this.liveByteCap = options.liveByteCapPerTarget ?? DEFAULT_LIVE_BYTE_CAP;
    this.retainedRowCap = options.retainedRowCapPerTarget ?? DEFAULT_RETAINED_ROW_CAP;
    this.retainedByteCap = options.retainedByteCapPerTarget ?? DEFAULT_RETAINED_BYTE_CAP;
    this.runMigration();
  }

  /**
   * Idempotently insert the exact prepared report before any external send.
   * A replay of the same delivery ID must carry the identical payload; any
   * divergence is an identity conflict and never silently overwrites.
   */
  reserve(input: ReportContextReservationInput): ReportContextEvent {
    const existing = this.db
      .prepare(
        `SELECT seq, delivery_id, target, mode, occurrence, provenance, text, payload_identity, state
         FROM telegram_report_context_events WHERE delivery_id = ?`
      )
      .get(input.deliveryId) as
      | {
          seq: number;
          delivery_id: string;
          target: string;
          mode: string;
          occurrence: string;
          provenance: string | null;
          text: string;
          payload_identity: string;
          state: ReportContextEventState;
        }
      | undefined;

    if (existing) {
      const semanticsMatch =
        existing.target === targetIdentity(input.target) &&
        existing.mode === input.mode &&
        existing.text === input.text;
      if (semanticsMatch && existing.payload_identity !== input.payloadIdentity) {
        // Design Decision 8: a richer pending artifact may replay a MIGRATED
        // delivery ID; the current identity is recorded as an alias only when
        // target, mode, exact text, and provenance all match.
        const isMigratedRow = existing.occurrence === JSON.stringify({ kind: 'legacy_v2' });
        const provenanceMatches =
          existing.provenance ===
          (input.provenance === undefined ? null : JSON.stringify(input.provenance));
        if (isMigratedRow && provenanceMatches) {
          this.db
            .prepare(
              'UPDATE telegram_report_context_events SET payload_identity_alias = ? WHERE delivery_id = ?'
            )
            .run(input.payloadIdentity, input.deliveryId);
          return { seq: existing.seq, deliveryId: existing.delivery_id, state: existing.state };
        }
      }
      if (!semanticsMatch || existing.payload_identity !== input.payloadIdentity) {
        throw new Error(
          `Owner report delivery ${input.deliveryId} identity conflict: replay does not match the reserved report`
        );
      }
      return { seq: existing.seq, deliveryId: existing.delivery_id, state: existing.state };
    }

    // Design Decision 5: compact consumed exact records under retained
    // pressure, then refuse the reservation outright when live data alone is
    // full. The failure happens BEFORE any Telegram send.
    this.compactRetained(input.target);
    this.enforceLiveCapacity(input.target);

    const inserted = this.db
      .prepare(
        `INSERT INTO telegram_report_context_events
           (delivery_id, target, mode, occurrence, provenance, text, payload_identity, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared_retryable', ?)
         RETURNING seq`
      )
      .get(
        input.deliveryId,
        targetIdentity(input.target),
        input.mode,
        JSON.stringify(input.occurrence),
        input.provenance === undefined ? null : JSON.stringify(input.provenance),
        input.text,
        input.payloadIdentity,
        this.nowIso()
      ) as { seq: number };

    return { seq: inserted.seq, deliveryId: input.deliveryId, state: 'prepared_retryable' };
  }

  /**
   * Atomically transition a confirmed send to delivered and consumed by the
   * standing owner runtime. The same runtime composed the report, so carrying
   * its full body into the next owner message would duplicate live context.
   */
  markDelivered(deliveryId: string, deliveredAtIso: string): void {
    const updated = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET state = 'delivered', disposition = 'consumed_turn',
             delivered_at = COALESCE(delivered_at, ?),
             consumed_by_ref = 'owner:runtime', consumed_at = COALESCE(consumed_at, ?)
         WHERE delivery_id = ?
           AND (state = 'prepared_retryable'
                OR (state = 'delivered' AND disposition = 'pending'))`
      )
      .run(deliveredAtIso, deliveredAtIso, deliveryId);
    if (updated.changes > 0) {
      return;
    }

    const existing = this.db
      .prepare('SELECT state FROM telegram_report_context_events WHERE delivery_id = ?')
      .get(deliveryId) as { state: ReportContextEventState } | undefined;
    if (!existing) {
      throw new Error(`Unknown owner report delivery ${deliveryId}`);
    }
    if (existing.state !== 'delivered') {
      throw new Error(
        `Owner report delivery ${deliveryId} cannot be marked delivered from state ${existing.state}`
      );
    }
  }

  /**
   * Compare-and-swap attempt lease: exactly one holder may execute a Telegram
   * send at a time. A live lease excludes every new claim - another worker,
   * another tick, or the same owner - and an expired lease is recoverable
   * after restart. Returns null when no claim is possible.
   */
  claimAttempt(
    deliveryId: string,
    owner: string,
    nowIso: string,
    leaseUntilIso: string
  ): { deliveryId: string; owner: string; leaseUntilIso: string } | null {
    const updated = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET attempt_owner = ?, lease_until = ?, attempt_count = attempt_count + 1
         WHERE delivery_id = ?
           AND state = 'prepared_retryable'
           AND (lease_until IS NULL OR lease_until < ?)
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
      )
      .run(owner, leaseUntilIso, deliveryId, nowIso, nowIso);
    if (updated.changes === 0) {
      return null;
    }
    return { deliveryId, owner, leaseUntilIso };
  }

  /**
   * Safe cancellation (design Decision 3): permitted only from
   * prepared_definite_rejection - the one state where the Telegram ledger
   * proves definite non-acceptance and no attempt lease is live. Ambiguous or
   * confirmed acceptance can never be cancelled. Replay on an already
   * cancelled row is a converging no-op that keeps the first audit record.
   */
  cancel(deliveryId: string, reason: string, operatorTimeIso: string): void {
    const updated = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET state = 'cancelled', cancel_reason = ?, cancelled_at = ?,
             attempt_owner = NULL, lease_until = NULL, next_attempt_at = NULL
         WHERE delivery_id = ? AND state = 'prepared_definite_rejection'
           AND attempt_owner IS NULL`
      )
      .run(reason, operatorTimeIso, deliveryId);
    if (updated.changes > 0) {
      return;
    }
    const existing = this.getEvent(deliveryId);
    if (existing?.state === 'cancelled') {
      return;
    }
    throw new Error(
      `Owner report delivery ${deliveryId} cannot be cancelled: only a definite rejection with no live attempt may be cancelled (state: ${existing?.state ?? 'unknown'})`
    );
  }

  /**
   * Explicit operator reactivation of a definite rejection after conditions
   * are corrected (for example the bot was unblocked). Same delivery ID, same
   * immutable target; the row becomes immediately recoverable.
   */
  reactivate(deliveryId: string): void {
    const updated = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET state = 'prepared_retryable', next_attempt_at = NULL
         WHERE delivery_id = ? AND state = 'prepared_definite_rejection'`
      )
      .run(deliveryId);
    if (updated.changes === 0) {
      const existing = this.getEvent(deliveryId);
      throw new Error(
        `Owner report delivery ${deliveryId} cannot be reactivated: only a definite rejection may be reactivated (state: ${existing?.state ?? 'unknown'})`
      );
    }
  }

  private compactRetained(target: ReportContextTarget): void {
    const compactOldestConsumed = this.db.prepare(
      `UPDATE telegram_report_context_events
       SET text = '', tombstone = 1
       WHERE seq = (
         SELECT seq FROM telegram_report_context_events
         WHERE target = ? AND tombstone = 0
           AND disposition IN ('consumed_turn', 'operator_archived')
         ORDER BY seq ASC LIMIT 1
       )`
    );
    // Retained = rows still carrying exact text.
    for (;;) {
      const retained = this.db
        .prepare(
          `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes
           FROM telegram_report_context_events WHERE target = ? AND tombstone = 0`
        )
        .get(targetIdentity(target)) as { rows: number; bytes: number };
      if (retained.rows < this.retainedRowCap && retained.bytes < this.retainedByteCap) {
        return;
      }
      const changed = compactOldestConsumed.run(targetIdentity(target)).changes;
      if (changed === 0) {
        // Nothing consumed left to compact; live pressure is handled by the
        // live-capacity check.
        return;
      }
    }
  }

  private enforceLiveCapacity(target: ReportContextTarget): void {
    const live = this.db
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes
         FROM telegram_report_context_events
         WHERE target = ? AND ${LIVE_ROW_CONDITION}`
      )
      .get(targetIdentity(target)) as { rows: number; bytes: number };
    if (live.rows >= this.liveRowCap || live.bytes >= this.liveByteCap) {
      throw new Error(
        `capacity_full: owner-report live capacity reached for target (${live.rows} rows, ${live.bytes} bytes); ` +
          'unseen reports must be consumed or explicitly archived before new ones are accepted'
      );
    }
  }

  /** Live usage for the status surface; warn at 80% of either bound. */
  liveUsage(target: ReportContextTarget): {
    rows: number;
    bytes: number;
    rowCap: number;
    byteCap: number;
    warn: boolean;
  } {
    const live = this.db
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes
         FROM telegram_report_context_events
         WHERE target = ? AND ${LIVE_ROW_CONDITION}`
      )
      .get(targetIdentity(target)) as { rows: number; bytes: number };
    return {
      rows: live.rows,
      bytes: live.bytes,
      rowCap: this.liveRowCap,
      byteCap: this.liveByteCap,
      warn: live.rows >= this.liveRowCap * 0.8 || live.bytes >= this.liveByteCap * 0.8,
    };
  }

  /**
   * Tombstone GC (design Decision 4): identity tombstones are retained up to
   * 365 days with a global count cap. No tombstone younger than Telegram's
   * seven-day replay window is ever pruned; beyond that floor the oldest
   * terminal tombstones go first. Returns the number of removed rows.
   */
  pruneTombstones(nowIso: string, options: { maxTombstones?: number } = {}): number {
    const cap = options.maxTombstones ?? DEFAULT_TOMBSTONE_CAP;
    const nowMs = new Date(nowIso).getTime();
    const floorIso = new Date(nowMs - TOMBSTONE_REPLAY_FLOOR_MS).toISOString();
    const maxAgeIso = new Date(nowMs - TOMBSTONE_MAX_AGE_MS).toISOString();

    let removed = this.db
      .prepare(
        `DELETE FROM telegram_report_context_events
         WHERE tombstone = 1 AND COALESCE(delivered_at, created_at) < ?`
      )
      .run(maxAgeIso).changes;

    for (;;) {
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events WHERE tombstone = 1')
        .get() as { n: number };
      if (count.n <= cap) {
        break;
      }
      const deleted = this.db
        .prepare(
          `DELETE FROM telegram_report_context_events
           WHERE seq = (
             SELECT seq FROM telegram_report_context_events
             WHERE tombstone = 1 AND COALESCE(delivered_at, created_at) < ?
             ORDER BY seq ASC LIMIT 1
           )`
        )
        .run(floorIso).changes;
      if (deleted === 0) {
        break;
      }
      removed += deleted;
    }
    return removed;
  }

  /** Read one event's attempt/terminal detail; null when unknown. */
  getEvent(deliveryId: string): ReportContextEventDetail | null {
    const row = this.db
      .prepare(
        `SELECT seq, delivery_id, state, attempt_count, next_attempt_at, lease_until,
                rejection_reason, cancel_reason
         FROM telegram_report_context_events WHERE delivery_id = ?`
      )
      .get(deliveryId) as
      | {
          seq: number;
          delivery_id: string;
          state: ReportContextEventState;
          attempt_count: number;
          next_attempt_at: string | null;
          lease_until: string | null;
          rejection_reason: string | null;
          cancel_reason: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      seq: row.seq,
      deliveryId: row.delivery_id,
      state: row.state,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      leaseUntil: row.lease_until,
      rejectionReason: row.rejection_reason,
      cancelReason: row.cancel_reason,
    };
  }

  /**
   * Record a retryable send failure: keep the row nonterminal, stamp the next
   * attempt time, and release the lease. Only the current lease holder may
   * reshape backoff - a stale worker's outcome must not race a live one.
   */
  scheduleRetry(deliveryId: string, owner: string, nextAttemptAtIso: string): void {
    const updated = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET next_attempt_at = ?, attempt_owner = NULL, lease_until = NULL
         WHERE delivery_id = ? AND state = 'prepared_retryable' AND attempt_owner = ?`
      )
      .run(nextAttemptAtIso, deliveryId, owner);
    if (updated.changes === 0) {
      throw new Error(
        `Worker ${owner} does not hold the attempt lease for owner report delivery ${deliveryId}`
      );
    }
  }

  /**
   * Record a definite Telegram non-acceptance. The row stays pinned in the
   * ledger (nonterminal) and is never automatically retried; only an explicit
   * operator action may reactivate it (design Decision 3).
   */
  markDefiniteRejection(deliveryId: string, owner: string, reason: string): void {
    const updated = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET state = 'prepared_definite_rejection', rejection_reason = ?,
             attempt_owner = NULL, lease_until = NULL, next_attempt_at = NULL
         WHERE delivery_id = ? AND state = 'prepared_retryable' AND attempt_owner = ?`
      )
      .run(reason, deliveryId, owner);
    if (updated.changes === 0) {
      throw new Error(
        `Worker ${owner} does not hold the attempt lease for owner report delivery ${deliveryId}`
      );
    }
  }

  /**
   * Startup/tick recovery: prepared_retryable rows that are due (no future
   * retry scheduled) and not held by a live attempt lease, oldest first.
   */
  listRecoverable(nowIso: string): ReportContextEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, delivery_id, state FROM telegram_report_context_events
         WHERE state = 'prepared_retryable'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (lease_until IS NULL OR lease_until < ?)
         ORDER BY seq ASC`
      )
      .all(nowIso, nowIso) as Array<{
      seq: number;
      delivery_id: string;
      state: ReportContextEventState;
    }>;
    return rows.map((row) => ({ seq: row.seq, deliveryId: row.delivery_id, state: row.state }));
  }

  /**
   * Startup ledger reconciliation input: every nonterminal row must hold a
   * Telegram-ledger pin, every terminal row must not (design Decision 2).
   */
  listPinReconciliation(): { nonterminal: string[]; terminal: string[] } {
    const rows = this.db
      .prepare(`SELECT delivery_id, state FROM telegram_report_context_events ORDER BY seq ASC`)
      .all() as Array<{ delivery_id: string; state: ReportContextEventState }>;
    const nonterminal: string[] = [];
    const terminal: string[] = [];
    for (const row of rows) {
      if (row.state === 'prepared_retryable' || row.state === 'prepared_definite_rejection') {
        nonterminal.push(row.delivery_id);
      } else {
        terminal.push(row.delivery_id);
      }
    }
    return { nonterminal, terminal };
  }

  private runMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_report_context_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('digest', 'full')),
        occurrence TEXT NOT NULL,
        provenance TEXT,
        text TEXT NOT NULL,
        payload_identity TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('prepared_retryable', 'prepared_definite_rejection', 'delivered', 'cancelled')
        ),
        disposition TEXT CHECK (
          disposition IN ('pending', 'consumed_turn', 'operator_archived')
        ),
        archived_by TEXT,
        archived_reason TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        attempt_owner TEXT,
        lease_until TEXT,
        rejection_reason TEXT,
        cancelled_at TEXT,
        cancel_reason TEXT,
        consumed_by_ref TEXT,
        consumed_at TEXT,
        payload_identity_alias TEXT,
        tombstone INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_report_context_events_target_state
        ON telegram_report_context_events(target, state);

    `);
  }
}
