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
import { scanForSecrets } from '../memory/secret-filter.js';
import type { ProcedureRef, TriggerProcedureStep } from './trigger-types.js';

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
const MAX_BATCH_EVENTS = 50;

export interface InboxBatch {
  channelKey: string;
  /** Identity + cause: EVERY event in the batch. */
  eventIds: string[];
  /** Frozen evidence identity for the whole batch, independent of bounded display lines. */
  eventRefs?: Array<{ eventId: string; observationRef: string | null }>;
  /** Bounded human-readable excerpt - display only, not paired with eventIds. */
  lines: string[];
  /** Immutable trigger contracts matched before the source cursor advanced. */
  activations: OwnerEventActivation[];
}

export interface OwnerEventActivation {
  procedureRef?: ProcedureRef;
  queuedProcedureRef?: ProcedureRef;
  availability?: 'available' | 'unavailable';
  resolutionReason?: string;

  triggerId: string;
  kind: string;
  memoryQuery: string;
  procedure: TriggerProcedureStep[];
  requiredEvidence: string[];
}

export interface InboxRow extends InboxBatch {
  eventRefs: Array<{ eventId: string; observationRef: string | null }>;
  id: number;
  status: 'pending' | 'claimed' | 'acked' | 'dead';
  attempts: number;
  /** Enqueue wall time; bounds which durable effects may count as this batch's receipt. */
  createdAt: number;
}

export type OwnerEventBatch = InboxRow;

export class OwnerEventInboxCorruptionError extends Error {
  readonly code = 'OWNER_EVENT_INBOX_CORRUPT';

  constructor(
    readonly rowId: number,
    cause: unknown
  ) {
    super(`Owner event inbox row ${rowId} is corrupt`, { cause });
    this.name = 'OwnerEventInboxCorruptionError';
  }
}

export interface OwnerEventPriorContextItem {
  observedAt: string;
  completedAt: string;
  observations: string[];
  outcome: 'acted' | 'no_update' | 'owner_decision_requested';
  effects: string[];
  note?: string;
  notification?: string;
}

export interface OwnerEventPriorContextAccess {
  currentBatchId: number;
  channelKey: string;
  principalRole: string;
  allowedRawConnectors: readonly string[];
  ownerTelegramChatId?: string | null;
}

interface StoredOwnerEventRow {
  id: number;
  channel_key: string;
  event_ids_json: string;
  event_refs_json?: string;
  lines_json: string;
  activations_json: string;
  attempts: number;
  created_at: number;
}

interface StoredPriorRow {
  id: number;
  event_ids_json: string;
  lines_json: string;
  unresolved_reason: string | null;
  created_at: number;
  acked_at: number;
}

function tableExists(db: SQLiteDatabase, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  );
}

function safeStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function historicalText(value: string): string {
  const flattened = value.replace(/[\r\n]+/g, ' ').trim();
  if (
    !scanForSecrets(flattened).clean ||
    /\b(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*\S+/i.test(flattened)
  ) {
    return '[redacted-secret]';
  }
  return flattened.slice(0, 800);
}

function safeRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function confirmedTelegramText(
  intentJson: string,
  resultJson: string | null,
  ownerTelegramChatId: string | null | undefined
): string | null {
  if (!ownerTelegramChatId) return null;
  const intent = safeRecord(intentJson);
  const result = safeRecord(resultJson);
  const variant = intent?.variant;
  if (
    intent?.version !== 1 ||
    intent.chatId !== ownerTelegramChatId ||
    typeof intent.deliveryId !== 'string' ||
    intent.deliveryId.length === 0 ||
    (variant !== 'text' && variant !== 'file' && variant !== 'image' && variant !== 'sticker') ||
    result?.version !== 1 ||
    result.state !== 'delivered' ||
    result.deliveryId !== intent.deliveryId ||
    result.variant !== variant ||
    typeof result.payloadIdentity !== 'string' ||
    result.payloadIdentity.length === 0 ||
    typeof result.confirmedAt !== 'number' ||
    !Number.isFinite(result.confirmedAt)
  ) {
    return null;
  }
  return typeof intent.message === 'string' && intent.message.trim()
    ? historicalText(intent.message)
    : null;
}

function isoTimestamp(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deadBatch(row: StoredOwnerEventRow, attempts: number): OwnerEventBatch {
  return {
    id: row.id,
    channelKey: row.channel_key,
    eventIds: JSON.parse(row.event_ids_json) as string[],
    eventRefs: parseEventRefs(row.event_refs_json, JSON.parse(row.event_ids_json) as string[]),
    lines: JSON.parse(row.lines_json) as string[],
    activations: JSON.parse(row.activations_json) as OwnerEventActivation[],
    status: 'dead',
    attempts,
    createdAt: row.created_at,
  };
}

function parseEventRefs(
  value: string | undefined,
  eventIds: string[]
): Array<{ eventId: string; observationRef: string | null }> {
  if (typeof value !== 'string') {
    throw new Error('owner_event_inbox.event_refs_json schema is required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`owner_event_inbox.event_refs_json is malformed: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('owner_event_inbox.event_refs_json must contain an array');
  }
  if (parsed.length === 0) {
    return eventIds.map((eventId) => ({ eventId, observationRef: null }));
  }
  const refs = parsed.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('owner_event_inbox.event_refs_json contains an invalid entry');
    }
    const candidate = item as { eventId?: unknown; observationRef?: unknown };
    if (
      typeof candidate.eventId !== 'string' ||
      candidate.eventId.trim() === '' ||
      (candidate.observationRef !== null &&
        (typeof candidate.observationRef !== 'string' || candidate.observationRef.trim() === ''))
    ) {
      throw new Error('owner_event_inbox.event_refs_json contains an invalid entry');
    }
    return {
      eventId: candidate.eventId,
      observationRef: candidate.observationRef as string | null,
    };
  });
  if (
    refs.length !== eventIds.length ||
    new Set(refs.map((ref) => ref.eventId)).size !== refs.length ||
    refs.some((ref) => !eventIds.includes(ref.eventId))
  ) {
    throw new Error('owner_event_inbox event refs do not match event ids');
  }
  return refs;
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
        event_refs_json TEXT NOT NULL DEFAULT '[]',
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
    // Host-written reason when a batch was ACKed without a ledger change (the
    // [decision] escape hatch). Counted, never self-graded by the model.
    if (!columns.some((column) => column.name === 'unresolved_reason')) {
      this.db.exec(`ALTER TABLE owner_event_inbox ADD COLUMN unresolved_reason TEXT`);
    }
    if (!columns.some((column) => column.name === 'event_refs_json')) {
      this.db.exec(
        `ALTER TABLE owner_event_inbox ADD COLUMN event_refs_json TEXT NOT NULL DEFAULT '[]'`
      );
    }
    // Prepared once: enqueue runs per channel per drain tick and re-preparing
    // statements per call was measurable on backfill drains.
    this.stmtInsertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO owner_event_inbox_events (event_id, seen_at) VALUES (?, ?)`
    );
    this.stmtInsertBatch = this.db.prepare(
      `INSERT INTO owner_event_inbox
         (channel_key, event_ids_json, event_refs_json, lines_json, activations_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.stmtClaimSelect = this.db.prepare(
      `SELECT id, channel_key, event_ids_json, event_refs_json, lines_json, activations_json, attempts, created_at
         FROM owner_event_inbox
        WHERE status = 'pending' AND COALESCE(retry_after, 0) <= ?
        ORDER BY id ASC LIMIT 1`
    );
    this.stmtClaimUpdate = this.db.prepare(
      `UPDATE owner_event_inbox SET status = 'claimed', claimed_at = ?
        WHERE id = ? AND status = 'pending'`
    );
    this.stmtAck = this.db.prepare(
      `UPDATE owner_event_inbox SET status = 'acked', acked_at = ?, unresolved_reason = ? WHERE id = ?`
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
    if (batch.eventIds.length === 0 || batch.eventIds.length > MAX_BATCH_EVENTS) {
      throw new Error(`Owner event batch must contain 1-${MAX_BATCH_EVENTS} events`);
    }
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
      for (const id of fresh) {
        this.stmtInsertEvent.run(id, now);
      }
      const freshSet = new Set(fresh);
      const freshRefs = parseEventRefs(
        JSON.stringify(batch.eventRefs ?? []),
        batch.eventIds
      ).filter((ref) => freshSet.has(ref.eventId));
      const hasFramedLines = batch.lines.some((line) => /\[id:[^\]]+\]/.test(line));
      const freshLines = hasFramedLines
        ? batch.lines.filter((line) => fresh.some((eventId) => line.includes(`[id:${eventId}]`)))
        : batch.lines;
      return this.stmtInsertBatch.run(
        batch.channelKey,
        JSON.stringify(fresh),
        JSON.stringify(freshRefs),
        JSON.stringify(freshLines),
        JSON.stringify(batch.activations),
        now
      );
    });
    return Number(run().lastInsertRowid);
  }

  claimNext(): InboxRow | null {
    let row = this.stmtClaimSelect.get(this.now()) as
      | {
          id: number;
          channel_key: string;
          event_ids_json: string;
          event_refs_json: string;
          lines_json: string;
          activations_json: string;
          attempts: number;
          created_at: number;
        }
      | undefined;
    while (row) {
      const candidate = row;
      let eventIds: string[];
      let eventRefs: Array<{ eventId: string; observationRef: string | null }>;
      let lines: string[];
      let activations: OwnerEventActivation[];
      try {
        eventIds = JSON.parse(candidate.event_ids_json) as string[];
        if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== 'string')) {
          throw new Error('event_ids_json is invalid');
        }
        eventRefs = parseEventRefs(candidate.event_refs_json, eventIds);
        lines = JSON.parse(candidate.lines_json) as string[];
        activations = JSON.parse(candidate.activations_json) as OwnerEventActivation[];
        if (!Array.isArray(lines) || !Array.isArray(activations)) {
          throw new Error('batch arrays are invalid');
        }
      } catch (error) {
        const diagnostic = new OwnerEventInboxCorruptionError(candidate.id, error);
        this.db
          .prepare(
            `UPDATE owner_event_inbox SET status = 'dead', last_error = ?, claimed_at = NULL
              WHERE id = ? AND status = 'pending'`
          )
          .run(`${diagnostic.code}:local-row-${candidate.id}`, candidate.id);
        row = this.stmtClaimSelect.get(this.now()) as
          | {
              id: number;
              channel_key: string;
              event_ids_json: string;
              event_refs_json: string;
              lines_json: string;
              activations_json: string;
              attempts: number;
              created_at: number;
            }
          | undefined;
        continue;
      }
      const claimed = this.stmtClaimUpdate.run(this.now(), candidate.id);
      if (claimed.changes !== 1) {
        return null;
      }
      return {
        id: candidate.id,
        channelKey: candidate.channel_key,
        eventIds,
        eventRefs,
        lines,
        activations,
        status: 'claimed',
        attempts: candidate.attempts,
        createdAt: candidate.created_at,
      };
    }
    return null;
  }

  /** ACK a batch; `unresolvedReason` names why it completed without a ledger change. */
  ack(id: number, unresolvedReason: string | null = null): void {
    this.stmtAck.run(this.now(), unresolvedReason, id);
  }

  /** Batches ACKed without a ledger change since `sinceMs`, newest first. */
  unresolvedAcks(sinceMs = 0, limit = 200): Array<{ id: number; reason: string; ackedAt: number }> {
    return (
      this.db
        .prepare(
          `SELECT id, unresolved_reason, acked_at FROM owner_event_inbox
            WHERE status = 'acked' AND unresolved_reason IS NOT NULL AND acked_at >= ?
            ORDER BY acked_at DESC, id DESC LIMIT ?`
        )
        .all(sinceMs, Math.min(Math.max(limit, 1), 1000)) as Array<{
        id: number;
        unresolved_reason: string;
        acked_at: number;
      }>
    ).map((row) => ({ id: row.id, reason: row.unresolved_reason, ackedAt: row.acked_at }));
  }

  /**
   * Return a claim to pending, or park it dead after MAX_ATTEMPTS. Returns
   * the resulting status so the caller can be LOUD about a dead batch - a
   * permanent loss must never be silent.
   */
  quarantine(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE owner_event_inbox SET status = 'dead', last_error = ?, claimed_at = NULL
      WHERE id = ? AND status IN ('claimed', 'pending')`
      )
      .run(reason.slice(0, 500), id);
  }

  /** Persist admission without changing the batch/effect identity (TG-05/TG-06). */
  saveAdmittedActivations(batch: OwnerEventBatch): void {
    const result = this.db
      .prepare(
        "UPDATE owner_event_inbox SET activations_json = ? WHERE id = ? AND status = 'claimed' AND attempts = ?"
      )
      .run(JSON.stringify(batch.activations), batch.id, batch.attempts);
    if (result.changes !== 1) throw new Error('owner event admission lease changed');
  }

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
        `SELECT id, channel_key, event_ids_json, event_refs_json, lines_json, activations_json, attempts, created_at
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
        `SELECT id, channel_key, event_ids_json, event_refs_json, lines_json, activations_json, attempts, created_at
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

  /**
   * Explicit bounded historical audit read, never automatic owner prompt context.
   * The continuing owner runtime already knows its outcomes. The journal has no
   * transferable principal grant, so callers must present the current owner
   * role and connector grant. Notification text additionally requires the
   * exact current Telegram target and a confirmed versioned receipt.
   */
  readPriorContext(input: OwnerEventPriorContextAccess): OwnerEventPriorContextItem[] {
    const separator = input.channelKey.indexOf(':');
    const connector = separator > 0 ? input.channelKey.slice(0, separator) : input.channelKey;
    if (
      input.principalRole !== 'owner_console' ||
      !input.allowedRawConnectors.includes(connector)
    ) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, event_ids_json, lines_json, unresolved_reason, created_at, acked_at
           FROM owner_event_inbox
          WHERE status = 'acked' AND channel_key = ? AND id <> ? AND acked_at IS NOT NULL
          ORDER BY acked_at DESC, id DESC
          LIMIT 10`
      )
      .all(input.channelKey, input.currentBatchId) as StoredPriorRow[];
    const hasEvidenceEffects = tableExists(this.db, 'evidence_effects');
    const hasExternalEffects = tableExists(this.db, 'owner_event_effects');
    const hasNoUpdates = tableExists(this.db, 'operator_no_update_notes');
    const context: OwnerEventPriorContextItem[] = [];

    for (const row of rows) {
      const observedAt = isoTimestamp(row.created_at);
      const completedAt = isoTimestamp(row.acked_at);
      if (!observedAt || !completedAt || row.acked_at < row.created_at) continue;
      const eventIds = safeStringArray(row.event_ids_json);
      const effectKinds = new Set<string>();
      if (hasEvidenceEffects && eventIds.length > 0) {
        for (let offset = 0; offset < eventIds.length; offset += SEEN_CHUNK) {
          const chunk = eventIds.slice(offset, offset + SEEN_CHUNK);
          const effects = this.db
            .prepare(
              `SELECT DISTINCT effect_kind FROM evidence_effects
                WHERE cause_state = 'attributed' AND channel_id = ?
                  AND created_at BETWEEN ? AND ?
                  AND EXISTS (
                    SELECT 1 FROM json_each(evidence_effects.source_event_ids_json)
                     WHERE json_each.value IN (${chunk.map(() => '?').join(', ')})
                  )`
            )
            .all(input.channelKey, row.created_at, row.acked_at, ...chunk) as Array<{
            effect_kind: string;
          }>;
          for (const effect of effects) effectKinds.add(effect.effect_kind);
        }
      }

      let notification: string | null = null;
      if (hasExternalEffects) {
        const externalRows = this.db
          .prepare(
            `SELECT effect_kind, intent_json, result_json
               FROM owner_event_effects
              WHERE batch_id = ? AND status = 'confirmed'
                AND created_at BETWEEN ? AND ? AND updated_at <= ?
              ORDER BY effect_kind ASC, action_key ASC`
          )
          .all(row.id, row.created_at, row.acked_at, row.acked_at) as Array<{
          effect_kind: string;
          intent_json: string;
          result_json: string | null;
        }>;
        for (const effect of externalRows) {
          if (effect.effect_kind === 'telegram_send') {
            const text = confirmedTelegramText(
              effect.intent_json,
              effect.result_json,
              input.ownerTelegramChatId
            );
            if (text !== null) {
              notification = text;
              effectKinds.add('telegram_send');
            }
          } else if (effect.effect_kind === 'drive_upload') {
            effectKinds.add('drive_upload');
          }
        }
      }

      const noUpdate = hasNoUpdates
        ? (this.db
            .prepare(
              `SELECT reason FROM operator_no_update_notes
                WHERE scope = ? AND created_at BETWEEN ? AND ?
                ORDER BY id DESC LIMIT 1`
            )
            .get(`owner-event:${row.id}`, row.created_at, row.acked_at) as
            | { reason: string }
            | undefined)
        : undefined;
      const ownerDecisionRequested =
        row.unresolved_reason === 'owner_decision_requested' && notification !== null;
      const hasActedEffect = [...effectKinds].some((kind) => kind !== 'telegram_send');
      const outcome = ownerDecisionRequested
        ? 'owner_decision_requested'
        : hasActedEffect
          ? 'acted'
          : noUpdate
            ? 'no_update'
            : null;
      if (outcome === null) continue;

      context.push({
        observedAt,
        completedAt,
        observations: safeStringArray(row.lines_json).slice(0, 10).map(historicalText),
        outcome,
        effects: [...effectKinds].sort(),
        ...(noUpdate ? { note: historicalText(noUpdate.reason) } : {}),
        ...(notification ? { notification } : {}),
      });
      if (context.length === 10) break;
    }
    return context;
  }
}
