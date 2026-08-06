/**
 * TG-05/TG-06: Telegram owner-report context inbox store.
 *
 * The messenger SQLite database is the single report-context authority for
 * owner-report delivery events and turn-consumption receipts
 * (docs/development/telegram-outbound-context-inbox-design.md, Decision 4).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { SQLiteDatabase } from '../sqlite.js';
import type { ReportCarryV2 } from '../operator/report-carry.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';

/**
 * TG-05 Slice K (design Decision 8): the EXACT legacy V2 prefix algorithm,
 * including the UTF-16 `slice(0, 700)` truncation (a surrogate split at the
 * boundary is preserved, not repaired). report-carry.ts deliberately does NOT
 * export its builder (legacy-export cull, pinned by report-carry.test.ts), so
 * this replica is pinned byte-for-byte against the public peek() surface by a
 * differential test instead.
 */
const LEGACY_CARRY_SUMMARY_MAX_CHARS = 700;

function legacyReportCarryPrefix(record: ReportCarryV2): string {
  const summary =
    record.text.length > LEGACY_CARRY_SUMMARY_MAX_CHARS
      ? `${record.text.slice(0, LEGACY_CARRY_SUMMARY_MAX_CHARS)}\n[... truncated - full text was delivered to the owner channel]`
      : record.text;
  return (
    `[Operator context] The last FULL situation report was delivered at ${record.deliveredAt}.\n` +
    'If the owner asks for a report or current status, reference/refresh THIS instead of ' +
    `reconstructing state from memory. Content:\n${wrapUntrustedContent(
      'operator-report-carry',
      summary
    )}\n---\n`
  );
}

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
  /**
   * TG-05 Slice K (design Decision 8): when set, the constructor solely
   * migrates the legacy V2 carry file (last-full-report.json) into the
   * event/legacy-restoration tables and renames the source `.migrated`.
   * No component reads or writes V2 afterward.
   */
  legacyCarryPath?: string;
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

function isLegacyCarryV2(value: unknown): value is ReportCarryV2 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const target = record.target as Record<string, unknown> | undefined;
  const provenance = record.provenance as Record<string, unknown> | undefined;
  return (
    record.version === 2 &&
    typeof record.deliveryId === 'string' &&
    record.deliveryId.length > 0 &&
    typeof target === 'object' &&
    target !== null &&
    target.source === 'telegram' &&
    typeof target.channelId === 'string' &&
    typeof record.deliveredAt === 'string' &&
    typeof record.text === 'string' &&
    typeof provenance === 'object' &&
    provenance !== null &&
    (record.consumedAt === undefined || typeof record.consumedAt === 'string')
  );
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
    if (options.legacyCarryPath) {
      this.migrateLegacyCarry(options.legacyCarryPath);
    }
  }

  /**
   * TG-05 Slice K: migrate the legacy V2 carry file. Unconsumed -> a
   * delivered-pending event (even past the old 24h TTL); consumed -> a
   * target-scoped legacy restoration record carrying the EXACT old prefix
   * bytes. Transactionally insert/verify, commit, then atomically rename the
   * source `.migrated`. Invalid files are quarantined and never injected.
   */
  private migrateLegacyCarry(path: string): void {
    if (!existsSync(path)) {
      return;
    }
    let record: ReportCarryV2;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isLegacyCarryV2(parsed)) {
        throw new Error('not a V2 report carry record');
      }
      record = parsed;
    } catch {
      renameSync(path, `${path}.quarantined-${Date.now()}`);
      return;
    }

    const provenanceTuple =
      record.provenance.status === 'available'
        ? ['available', record.provenance.modelRunId]
        : ['unavailable', record.provenance.reason];
    const payloadIdentity = createHash('sha256')
      .update(
        JSON.stringify([
          'legacy-report-carry-v2',
          record.deliveryId,
          record.target.source,
          record.target.channelId,
          record.deliveredAt,
          record.text,
          provenanceTuple,
        ]),
        'utf8'
      )
      .digest('hex');

    this.db.transaction(() => {
      if (record.consumedAt) {
        const existing = this.db
          .prepare(
            'SELECT payload_identity FROM telegram_report_legacy_restorations WHERE delivery_id = ?'
          )
          .get(record.deliveryId) as { payload_identity: string } | undefined;
        if (existing) {
          if (existing.payload_identity !== payloadIdentity) {
            throw new Error(
              `Legacy carry ${record.deliveryId} identity conflict during migration replay`
            );
          }
          return;
        }
        const restorationText = legacyReportCarryPrefix(record);
        this.db
          .prepare(
            `INSERT INTO telegram_report_legacy_restorations
               (delivery_id, target, channel_key, delivered_at, consumed_at,
                restoration_text, legacy_projection_hash, payload_identity)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            record.deliveryId,
            targetIdentity(record.target),
            record.consumingChannelKey ?? null,
            record.deliveredAt,
            record.consumedAt,
            // JSON-encoded: the legacy UTF-16 slice(0,700) can split a
            // surrogate pair, and a lone surrogate does not survive SQLite's
            // UTF-8 TEXT round-trip. JSON escapes it losslessly.
            JSON.stringify(restorationText),
            createHash('sha256').update(restorationText, 'utf8').digest('hex'),
            payloadIdentity
          );
        return;
      }

      const existing = this.db
        .prepare(
          'SELECT payload_identity FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get(record.deliveryId) as { payload_identity: string } | undefined;
      if (existing) {
        if (existing.payload_identity !== payloadIdentity) {
          throw new Error(
            `Legacy carry ${record.deliveryId} identity conflict during migration replay`
          );
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO telegram_report_context_events
             (delivery_id, target, mode, occurrence, provenance, text, payload_identity,
              state, disposition, created_at, delivered_at)
           VALUES (?, ?, 'full', ?, ?, ?, ?, 'delivered', 'pending', ?, ?)`
        )
        .run(
          record.deliveryId,
          targetIdentity(record.target),
          JSON.stringify({ kind: 'legacy_v2' }),
          JSON.stringify(record.provenance),
          record.text,
          payloadIdentity,
          this.nowIso(),
          record.deliveredAt
        );
    })();

    renameSync(path, `${path}.migrated`);
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
   * Atomically transition a confirmed send to `delivered`. Idempotent: an
   * already-delivered row keeps its original delivery time so crash-recovery
   * replays converge instead of rewriting history.
   */
  markDelivered(deliveryId: string, deliveredAtIso: string): void {
    const updated = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET state = 'delivered', disposition = 'pending', delivered_at = ?
         WHERE delivery_id = ? AND state = 'prepared_retryable'`
      )
      .run(deliveredAtIso, deliveryId);
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

  /**
   * Delivered reports not yet consumed by an owner turn, for one exact
   * target, oldest first. This is the pending-projection source; one chat can
   * never read another target's reports.
   */
  listDeliveredPending(target: ReportContextTarget): Array<{
    seq: number;
    deliveryId: string;
    mode: 'digest' | 'full';
    deliveredAtIso: string;
    text: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT seq, delivery_id, mode, delivered_at, text
         FROM telegram_report_context_events
         WHERE target = ? AND state = 'delivered' AND disposition = 'pending'
         ORDER BY seq ASC`
      )
      .all(targetIdentity(target)) as Array<{
      seq: number;
      delivery_id: string;
      mode: 'digest' | 'full';
      delivered_at: string;
      text: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      deliveryId: row.delivery_id,
      mode: row.mode,
      deliveredAtIso: row.delivered_at,
      text: row.text,
    }));
  }

  /**
   * Committed receipts for the given source-message references, in the input
   * order. Only text-bearing receipts are returned; a compacted receipt no
   * longer restores.
   */
  listReceiptsByRefs(refs: string[]): Array<{
    sourceMessageRef: string;
    deliveryIds: string[];
    projectionText: string;
    committedAtIso: string;
  }> {
    const lookup = this.db.prepare(
      `SELECT source_message_ref, delivery_ids, projection_text, committed_at
       FROM telegram_report_context_receipts WHERE source_message_ref = ?`
    );
    const results: Array<{
      sourceMessageRef: string;
      deliveryIds: string[];
      projectionText: string;
      committedAtIso: string;
    }> = [];
    for (const ref of refs) {
      const row = lookup.get(ref) as
        | {
            source_message_ref: string;
            delivery_ids: string;
            projection_text: string | null;
            committed_at: string;
          }
        | undefined;
      if (!row || row.projection_text === null) {
        continue;
      }
      results.push({
        sourceMessageRef: row.source_message_ref,
        deliveryIds: JSON.parse(row.delivery_ids) as string[],
        projectionText: row.projection_text,
        committedAtIso: row.committed_at,
      });
    }
    return results;
  }

  /**
   * Legacy V2 restorations for one target, eligible for fresh-session history
   * (30 days after consumption, design Decision 8). Restoration text is
   * JSON-decoded back to the exact legacy prefix string.
   */
  listLegacyRestorations(
    target: ReportContextTarget,
    nowIso: string
  ): Array<{
    deliveryId: string;
    consumedAtIso: string;
    deliveredAtIso: string;
    restorationText: string;
  }> {
    const cutoff = new Date(new Date(nowIso).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT delivery_id, consumed_at, delivered_at, restoration_text
         FROM telegram_report_legacy_restorations
         WHERE target = ? AND consumed_at >= ? AND restoration_text IS NOT NULL
         ORDER BY consumed_at ASC, delivery_id ASC`
      )
      .all(targetIdentity(target), cutoff) as Array<{
      delivery_id: string;
      consumed_at: string;
      delivered_at: string;
      restoration_text: string;
    }>;
    return rows.map((row) => ({
      deliveryId: row.delivery_id,
      consumedAtIso: row.consumed_at,
      deliveredAtIso: row.delivered_at,
      restorationText: JSON.parse(row.restoration_text) as string,
    }));
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

  /**
   * Design Decision 5: explicit two-step operator action (token flow lives at
   * the API layer). Archives ONLY already-delivered pending rows up to and
   * including `throughSeq`, records the audit fields, and removes them from
   * pending projection and live capacity. Never Telegram cancellation.
   */
  archiveDelivered(
    target: ReportContextTarget,
    throughSeq: number,
    actor: string,
    reason: string,
    nowIso: string
  ): string[] {
    const rows = this.db
      .prepare(
        `UPDATE telegram_report_context_events
         SET disposition = 'operator_archived', archived_by = ?, archived_reason = ?, archived_at = ?
         WHERE target = ? AND state = 'delivered' AND disposition = 'pending' AND seq <= ?
         RETURNING delivery_id`
      )
      .all(actor, reason, nowIso, targetIdentity(target), throughSeq) as Array<{
      delivery_id: string;
    }>;
    return rows.map((row) => row.delivery_id);
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

      CREATE TABLE IF NOT EXISTS telegram_report_legacy_restorations (
        delivery_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        channel_key TEXT,
        delivered_at TEXT NOT NULL,
        consumed_at TEXT NOT NULL,
        restoration_text TEXT,
        legacy_projection_hash TEXT NOT NULL,
        payload_identity TEXT NOT NULL,
        source_message_ref TEXT,
        session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS telegram_report_context_receipts (
        source_message_ref TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        delivery_ids TEXT NOT NULL,
        projection_version TEXT NOT NULL,
        projection_text TEXT,
        projection_hash TEXT NOT NULL,
        final_response_sha256 TEXT NOT NULL,
        committed_at TEXT NOT NULL
      );
    `);
  }
}
