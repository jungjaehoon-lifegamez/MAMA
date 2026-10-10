/**
 * The mailbox — durable intake, schedule, delivery and ack. Nothing else.
 *
 * v7 §4.3 gives this store four jobs and names what it must not do: it manages
 * durable delivery/ack and mechanical concurrency ONLY; it does not classify an
 * original as work, and it does not pre-emptively create a task row. §4.4 says
 * the same from the other side — no `acted/no_update/owner_question`
 * classification may be invented here.
 *
 * So the fields are only the ones that hold for any consumer: identity,
 * principal, source, content notice, time, where a reply goes, what may merge
 * with what, and delivery state. A stimulus's MEANING belongs to the agent
 * that reads it, and a consumer's vocabulary for that meaning belongs to the
 * consumer — a product's trigger-loop intake may add its own display lines and
 * procedure activations (design W6 correction). A core that exported those words would make "receive
 * something durably" unusable without importing them.
 *
 * What this is NOT, and where that lives instead:
 *   - It does not run a turn, retry a model, or know a turn's outcome. That is
 *     the native session (`native-session.ts`), which already
 *     provides native protocol and turn observations. `ack` says the loop took the
 *     stimulus; it never says the work is done.
 *   - It does not deliver anything outward. An effect receipt is the effect
 *     ledger's (`operations.ts`).
 */
import type { DatabaseAdapter } from '../db-manager.js';
import type { JsonValue } from '../memory/judgment-types.js';
import { decodeStimulusPayload, encodeStimulusPayload } from './stimulus-payload.js';
import { NativeInputJournal, type NativeDeliveryRecord } from './native-input-journal.js';

/**
 * What kind of stimulus a row holds — v7 R2 inputs and a native harness event.
 *
 * Stated by the producer, never derived from the payload: a host that read a
 * message body to decide what kind of work it is would be doing the
 * classification this contract removes.
 */
export type StimulusKind = 'owner_message' | 'source_delta' | 'scheduled' | 'native_event';

const STIMULUS_KINDS: ReadonlySet<string> = new Set([
  'owner_message',
  'source_delta',
  'scheduled',
  'native_event',
]);

export function isStimulusKind(value: unknown): value is StimulusKind {
  return typeof value === 'string' && STIMULUS_KINDS.has(value);
}

/** One preserved observation this stimulus points at. Identity, not content. */
export interface StimulusRef {
  /** The producer's id for the observation; the dedupe key. */
  refId: string;
  /** Where the preserved original is readable, when the producer preserved one. */
  observationRef: string | null;
}

/**
 * One stimulus as its producer states it.
 *
 * `preview` is the bounded change notice of §4.4 — never the whole context and
 * never a task list. The agent reads the rest through the source actions when
 * it decides it needs to.
 */
export interface Stimulus {
  /** The producer's identity for this stimulus. Dedupe key when it states no refs. */
  id: string;
  kind: StimulusKind;
  /** Whose stimulus this is. The runtime refuses a principal it does not serve. */
  principalId: string;
  /** Where it came from — durable channel identity, canonical at the producer. */
  channelKey: string;
  /** Preserved observation identity, when the producer has any. */
  refs?: readonly StimulusRef[];
  /** Bounded change notice. Display, not context. */
  preview?: readonly string[];
  /** Consumer-owned JSON input, retained verbatim in meaning, never interpreted here. */
  payload?: JsonValue;
  /** Where an answer goes back, when the producer can name it. */
  replyTo?: string | null;
  /**
   * What may merge with what.
   *
   * Pending stimuli sharing a key, payload, kind and destination can become one
   * row — the mechanical concurrency §4.3 assigns here. It is the producer's key, and
   * merging is append-only: refs and preview join, nothing is dropped and
   * nothing is interpreted. A producer that states none gets no merging.
   */
  coalesceKey?: string | null;
  /** When it happened, as against when it was accepted. */
  occurredAt: number;
}

/** A stimulus as it was stored, with its delivery state. */
export interface MailboxRow {
  id: number;
  stimulusId: string;
  kind: StimulusKind | null;
  principalId: string;
  channelKey: string;
  refs: StimulusRef[];
  preview: string[];
  /** Absent on inputs accepted before payload preservation was supported. */
  payload?: JsonValue;
  replyTo: string | null;
  coalesceKey: string | null;
  occurredAt: number;
  createdAt: number;
  status: 'pending' | 'claimed' | 'acked' | 'dead';
  attempts: number;
  nativeDelivery?: NativeDeliveryRecord;
}

/** Bounded provenance for inputs sharing one native turn; no payload is projected. */
export interface NativeTurnInputRef {
  id: number;
  stimulusId: string;
  kind: StimulusKind | null;
  channelKey: string;
  occurredAt: number;
  status: MailboxRow['status'];
}

/** A row the mailbox refused to parse. Parked dead, never silently dropped. */
export class MailboxCorruptionError extends Error {
  readonly code = 'MAILBOX_CORRUPT';

  constructor(
    readonly rowId: number,
    cause: unknown
  ) {
    super(`Mailbox row ${rowId} is corrupt`, { cause });
    this.name = 'MailboxCorruptionError';
  }
}

/**
 * The backoff and retention schedule, carried over unchanged from the intake
 * this generalises: five attempts, then the row parks dead and visible.
 */
const MAX_ATTEMPTS = 5;
const ACKED_RETENTION_MS = 7 * 86_400_000;
/**
 * Pending rows older than this park as dead so a long provider outage cannot
 * replay months of stale input. Dead rows stay visible in depth().
 */
const PENDING_RETENTION_MS = 7 * 86_400_000;
/**
 * Dedupe horizon. Ref ids must outlive their row or a redelivery after pruning
 * re-processes old input — but not forever either (one TEXT-PK row per ref ever
 * accepted). 30 days is far wider than any redelivery gap a cursor produces.
 */
const REF_RETENTION_MS = 30 * 86_400_000;
const SEEN_CHUNK = 500; // stay under SQLITE_MAX_VARIABLE_NUMBER
/**
 * Replay deltas intentionally carry one channel's bounded source history. The
 * feeder preflights this same contract before accepting any window so a
 * large channel cannot be silently split or partially delivered.
 */
const MAX_REFS = 500;

function backoffCase(column: string): string {
  return `CASE ${column}
    WHEN 0 THEN 60000
    WHEN 1 THEN 300000
    WHEN 2 THEN 1800000
    WHEN 3 THEN 7200000
    ELSE 43200000
  END`;
}

interface StoredRow {
  id: number;
  stimulus_id: string;
  kind: string | null;
  principal_id: string;
  channel_key: string;
  preview_json: string;
  payload_json: string | null;
  reply_to: string | null;
  coalesce_key: string | null;
  occurred_at: number;
  created_at: number;
  attempts: number;
}

export class Mailbox {
  readonly nativeInputs: NativeInputJournal;
  private readonly stmtInsertSeen;
  private readonly stmtInsert;
  private readonly stmtInsertRef;
  private readonly stmtRefsFor;
  private readonly stmtClaimSelect;
  private readonly stmtClaimSelectKind;
  private readonly stmtClaimUpdate;
  private readonly stmtAck;
  private readonly stmtRetry;
  private readonly stmtRetryStatus;
  private readonly stmtPruneAcked;
  private readonly stmtPrunePending;
  private readonly stmtPruneSeen;
  private readonly stmtReplay;
  private readonly stmtDepth;
  private readonly stmtPendingCoalesced;
  private readonly stmtAppendPreview;
  private readonly stmtIdentityPayload;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly clock: () => number = () => Date.now()
  ) {
    // Declared by core migrations 086/087. Repeated here for the same reason every
    // core store repeats its own shape: a consumer may open this against a
    // database its own assembly created.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stimulus_id TEXT NOT NULL,
        kind TEXT,
        principal_id TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        preview_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT,
        reply_to TEXT,
        coalesce_key TEXT,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','claimed','acked','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claimed_at INTEGER,
        acked_at INTEGER,
        retry_after INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_inputs_status
        ON mailbox_inputs(status, id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_inputs_coalesce
        ON mailbox_inputs(status, coalesce_key);
      CREATE INDEX IF NOT EXISTS idx_mailbox_inputs_identity
        ON mailbox_inputs(principal_id, stimulus_id);
      CREATE TABLE IF NOT EXISTS mailbox_input_refs (
        input_id INTEGER NOT NULL REFERENCES mailbox_inputs(id) ON DELETE CASCADE,
        ref_id TEXT NOT NULL,
        observation_ref TEXT,
        PRIMARY KEY (input_id, ref_id)
      );
      CREATE TABLE IF NOT EXISTS mailbox_seen (
        ref_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL DEFAULT 0,
        principal_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_seen_at ON mailbox_seen(seen_at);
      CREATE TABLE IF NOT EXISTS mailbox_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_key TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        fired_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_schedules_due
        ON mailbox_schedules(fired_at, due_at);
    `);

    // Consumers create these stores without running the core migration chain.
    const seenColumns = this.db.prepare('PRAGMA table_info(mailbox_seen)').all() as Array<{
      name: string;
    }>;
    if (!seenColumns.some((column) => column.name === 'principal_id')) {
      this.db.exec('ALTER TABLE mailbox_seen ADD COLUMN principal_id TEXT');
    }
    this.nativeInputs = new NativeInputJournal(db, clock);
    // Prepared once: enqueue runs per producer tick and re-preparing per call
    // was measurable on backfill drains.
    this.stmtInsertSeen = this.db.prepare(
      `INSERT OR IGNORE INTO mailbox_seen (ref_id, seen_at, principal_id) VALUES (?, ?, ?)`
    );
    this.stmtInsert = this.db.prepare(
      `INSERT INTO mailbox_inputs
         (stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, reply_to,
          coalesce_key, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtInsertRef = this.db.prepare(
      `INSERT OR IGNORE INTO mailbox_input_refs (input_id, ref_id, observation_ref)
       VALUES (?, ?, ?)`
    );
    this.stmtRefsFor = this.db.prepare(
      `SELECT ref_id, observation_ref FROM mailbox_input_refs WHERE input_id = ? ORDER BY rowid ASC`
    );
    this.stmtClaimSelect = this.db.prepare(
      `SELECT id, stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, reply_to,
              coalesce_key, occurred_at, created_at, attempts
         FROM mailbox_inputs
        WHERE status = 'pending' AND COALESCE(retry_after, 0) <= ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state!='prepared')
        ORDER BY id ASC LIMIT 1`
    );
    this.stmtClaimSelectKind = this.db.prepare(
      `SELECT id, stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, reply_to,
              coalesce_key, occurred_at, created_at, attempts
         FROM mailbox_inputs
        WHERE status = 'pending' AND COALESCE(retry_after, 0) <= ? AND kind = ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state!='prepared')
        ORDER BY id ASC LIMIT 1`
    );
    this.stmtClaimUpdate = this.db.prepare(
      `UPDATE mailbox_inputs SET status = 'claimed', claimed_at = ?
        WHERE id = ? AND status = 'pending'`
    );
    this.stmtAck = this.db.prepare(
      `UPDATE mailbox_inputs SET status = 'acked', acked_at = ? WHERE id = ?`
    );
    this.stmtRetry = this.db.prepare(
      `UPDATE mailbox_inputs
          SET status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'pending' END,
              attempts = attempts + 1, last_error = ?, claimed_at = NULL,
              retry_after = ? + ${backoffCase('attempts')}
        WHERE id = ? AND status = 'claimed'`
    );
    this.stmtRetryStatus = this.db.prepare(`SELECT status FROM mailbox_inputs WHERE id = ?`);
    this.stmtPruneAcked = this.db.prepare(
      `DELETE FROM mailbox_inputs WHERE status = 'acked' AND acked_at <= ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state IN ('dispatching','accepted','uncertain'))`
    );
    this.stmtPrunePending = this.db.prepare(
      `UPDATE mailbox_inputs
          SET status = 'dead', last_error = 'stale_pending_expired'
        WHERE status = 'pending' AND created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state IN ('dispatching','accepted','uncertain'))`
    );
    this.stmtPruneSeen = this.db.prepare(`DELETE FROM mailbox_seen WHERE seen_at <= ?
      AND NOT EXISTS (SELECT 1 FROM mailbox_input_refs r JOIN native_input_deliveries n ON n.input_id=r.input_id
        WHERE r.ref_id=mailbox_seen.ref_id AND n.state IN ('dispatching','accepted','uncertain'))`);
    // Same poison cap as retry(): a claim that expires its lease repeatedly
    // (hung run, process death mid-flight) parks dead too, rather than
    // re-pending forever at the head of the queue.
    this.stmtReplay = this.db.prepare(
      `UPDATE mailbox_inputs
          SET status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'pending' END,
              attempts = attempts + 1, claimed_at = NULL,
              retry_after = ? + ${backoffCase('attempts')}
        WHERE status = 'claimed' AND COALESCE(claimed_at, 0) <= ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state!='prepared')`
    );
    // Grouped on the (status, id) index; never scans the acked bulk.
    this.stmtDepth = this.db.prepare(
      `SELECT status, COUNT(*) AS n FROM mailbox_inputs
        WHERE status IN ('pending','claimed','dead') GROUP BY status`
    );
    this.stmtPendingCoalesced = this.db.prepare(
      `SELECT id, preview_json FROM mailbox_inputs
        WHERE status = 'pending' AND coalesce_key = ? AND principal_id = ?
          AND payload_json IS ? AND kind IS ? AND channel_key = ? AND reply_to IS ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state!='prepared')
        ORDER BY id ASC LIMIT 1`
    );
    this.stmtAppendPreview = this.db.prepare(
      `UPDATE mailbox_inputs SET preview_json = ? WHERE id = ? AND status = 'pending'`
    );
    this.stmtIdentityPayload = this.db.prepare(
      `SELECT payload_json FROM mailbox_inputs
        WHERE principal_id = ? AND (stimulus_id = ? OR id IN (
          SELECT input_id FROM mailbox_input_refs WHERE ref_id = ?
        )) ORDER BY id DESC LIMIT 1`
    );
  }

  private now(): number {
    return this.clock();
  }

  /**
   * Make a stimulus durable. Returns the row id, or `null` when every ref it
   * carries was already accepted.
   *
   * Dedupe is PER REF, not per stimulus shape. A boundary key fails on partial
   * redelivery: [r1] enqueues, the producer's cursor commit fails, the next
   * tick delivers [r1,r2] under a different boundary — and r1 runs twice.
   * A stimulus with no unseen ref is dropped; one with any unseen ref is
   * stored with exactly its unseen refs.
   */
  enqueue(stimulus: Stimulus): number | null {
    if (!isStimulusKind(stimulus.kind)) {
      throw new Error(`Mailbox: unknown stimulus kind "${String(stimulus.kind)}"`);
    }
    if (stimulus.principalId.trim() === '') {
      throw new Error('Mailbox: a stimulus states whose it is');
    }
    if (stimulus.channelKey.trim() === '') {
      throw new Error('Mailbox: a stimulus states where it came from');
    }
    const payload = encodeStimulusPayload(stimulus.payload);
    const accepted = this.stmtIdentityPayload.get(
      stimulus.principalId,
      stimulus.id,
      stimulus.id
    ) as { payload_json: string | null } | undefined;
    if (accepted && accepted.payload_json !== payload) {
      throw new Error('Mailbox payload conflict for an accepted stimulus identity');
    }
    // With no refs stated the producer's own id is the identity, so a
    // redelivery of the same stimulus dedupes on it rather than opening a
    // second row.
    const stated: StimulusRef[] =
      stimulus.refs && stimulus.refs.length > 0
        ? stimulus.refs.map((ref) => ({ refId: ref.refId, observationRef: ref.observationRef }))
        : [{ refId: stimulus.id, observationRef: null }];
    if (stated.length > MAX_REFS) {
      throw new Error(`Mailbox: a stimulus carries at most ${MAX_REFS} refs`);
    }
    for (const ref of stated) {
      if (typeof ref.refId !== 'string' || ref.refId.trim() === '') {
        throw new Error('Mailbox: a ref states its id');
      }
    }

    const seen = new Set<string>();
    const refIds = stated.map((ref) => ref.refId);
    for (let i = 0; i < refIds.length; i += SEEN_CHUNK) {
      const chunk = refIds.slice(i, i + SEEN_CHUNK);
      const rows = this.db
        .prepare(
          `SELECT ref_id FROM mailbox_seen WHERE ref_id IN (${chunk.map(() => '?').join(',')})`
        )
        .all(...chunk) as Array<{ ref_id: string }>;
      for (const row of rows) seen.add(row.ref_id);
    }
    const fresh = stated.filter((ref) => !seen.has(ref.refId));
    if (fresh.length === 0) {
      return null; // fully redelivered — already durable
    }

    const preview = [...(stimulus.preview ?? [])];
    return this.db.transaction(() => {
      const now = this.now();
      for (const ref of fresh) {
        this.stmtInsertSeen.run(ref.refId, now, stimulus.principalId);
      }
      // Mechanical merge: an existing pending row with the same producer key
      // and principal takes these refs instead of opening a second row. Both
      // rows are still pending, so nothing that was already handed to the loop
      // is touched.
      const key = stimulus.coalesceKey ?? null;
      if (key !== null && key !== '') {
        const open = this.stmtPendingCoalesced.get(
          key,
          stimulus.principalId,
          payload,
          stimulus.kind,
          stimulus.channelKey,
          stimulus.replyTo ?? null
        ) as { id: number; preview_json: string } | undefined;
        if (open) {
          for (const ref of fresh) {
            this.stmtInsertRef.run(open.id, ref.refId, ref.observationRef);
          }
          if (preview.length > 0) {
            const existing = JSON.parse(open.preview_json) as string[];
            this.stmtAppendPreview.run(JSON.stringify([...existing, ...preview]), open.id);
          }
          return open.id;
        }
      }
      const inserted = this.stmtInsert.run(
        stimulus.id,
        stimulus.kind,
        stimulus.principalId,
        stimulus.channelKey,
        JSON.stringify(preview),
        payload,
        stimulus.replyTo ?? null,
        key,
        stimulus.occurredAt,
        now
      );
      const id = Number(inserted.lastInsertRowid);
      for (const ref of fresh) {
        this.stmtInsertRef.run(id, ref.refId, ref.observationRef);
      }
      return id;
    });
  }

  /**
   * Take the next pending row under a lease. A corrupt row parks dead and the
   * scan continues.
   *
   * `prefer` orders kinds ahead of the rest, oldest-first within each. It is
   * ordering, not meaning: §4.3 forbids a host FIFO in which the person's
   * current request waits behind a mass replay, and the kind a producer stated
   * is the only thing that can say which is which without reading content.
   */
  claimNext(options: { prefer?: readonly StimulusKind[] } = {}): MailboxRow | null {
    const prefer = options.prefer ?? [];
    const select = (): StoredRow | undefined => {
      const now = this.now();
      for (const kind of prefer) {
        const preferred = this.stmtClaimSelectKind.get(now, kind) as StoredRow | undefined;
        if (preferred) return preferred;
      }
      return this.stmtClaimSelect.get(now) as StoredRow | undefined;
    };
    let row = select();
    while (row) {
      const candidate = row;
      let preview: string[];
      let hydrated: MailboxRow;
      try {
        preview = JSON.parse(candidate.preview_json) as string[];
        if (!Array.isArray(preview) || preview.some((line) => typeof line !== 'string')) {
          throw new Error('preview_json is invalid');
        }
        hydrated = this.hydrate(candidate, preview);
      } catch (error) {
        const diagnostic = new MailboxCorruptionError(candidate.id, error);
        this.db
          .prepare(
            `UPDATE mailbox_inputs SET status = 'dead', last_error = ?, claimed_at = NULL
              WHERE id = ? AND status = 'pending'`
          )
          .run(`${diagnostic.code}:row-${candidate.id}`, candidate.id);
        row = select();
        continue;
      }
      const claimed = this.stmtClaimUpdate.run(this.now(), candidate.id);
      if (claimed.changes !== 1) {
        return null;
      }
      return { ...hydrated, status: 'claimed' };
    }
    return null;
  }

  private hydrate(row: StoredRow, preview: string[]): MailboxRow {
    const nativeDelivery = this.nativeInputs.get(row.id);
    const refs = (
      this.stmtRefsFor.all(row.id) as Array<{ ref_id: string; observation_ref: string | null }>
    ).map((ref) => ({ refId: ref.ref_id, observationRef: ref.observation_ref }));
    return {
      id: row.id,
      stimulusId: row.stimulus_id,
      kind: isStimulusKind(row.kind) ? row.kind : null,
      principalId: row.principal_id,
      channelKey: row.channel_key,
      refs,
      preview,
      ...(row.payload_json === null ? {} : { payload: decodeStimulusPayload(row.payload_json) }),
      replyTo: row.reply_to,
      coalesceKey: row.coalesce_key,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      status: 'pending',
      attempts: row.attempts,
      ...(nativeDelivery ? { nativeDelivery } : {}),
    };
  }

  /** Renew only a live runtime-owned claim; native ACKs remain independent. */
  renewClaim(id: number, now = this.now()): void {
    this.db
      .prepare("UPDATE mailbox_inputs SET claimed_at=? WHERE id=? AND status='claimed'")
      .run(now, id);
  }

  /** Inspect one accepted input without claiming it or changing its lease. */
  readInput(stimulusId: string, principalId: string): MailboxRow | null {
    const row = this.db
      .prepare(
        `SELECT id, stimulus_id, kind, principal_id, channel_key,
      preview_json, payload_json, reply_to, coalesce_key, occurred_at, created_at, attempts, status
      FROM mailbox_inputs WHERE stimulus_id = ? AND principal_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(stimulusId, principalId) as (StoredRow & { status: MailboxRow['status'] }) | undefined;
    if (!row) return null;
    try {
      const preview: unknown = JSON.parse(row.preview_json);
      if (!Array.isArray(preview) || preview.some((line) => typeof line !== 'string')) {
        throw new Error('Invalid input preview');
      }
      return { ...this.hydrate(row, preview), status: row.status };
    } catch (error) {
      throw new MailboxCorruptionError(row.id, error);
    }
  }

  /** Reopen claims that never crossed the native dispatch boundary. */
  recoverOrphanedClaims(now = this.now()): number {
    return this.db.transaction(() => {
      const replayed = this.db
        .prepare(
          `UPDATE mailbox_inputs
              SET status='pending', claimed_at=NULL, retry_after=NULL
            WHERE status='claimed'
              AND NOT EXISTS (
                SELECT 1 FROM native_input_deliveries n
                 WHERE n.input_id=mailbox_inputs.id
                   AND n.state IN ('dispatching','accepted','uncertain','settled')
              )`
        )
        .run().changes;
      this.db
        .prepare(
          `UPDATE mailbox_inputs
              SET status='acked', acked_at=COALESCE(acked_at, ?), claimed_at=NULL
            WHERE status='claimed'
              AND EXISTS (
                SELECT 1 FROM native_input_deliveries n
                 WHERE n.input_id=mailbox_inputs.id AND n.state='settled'
              )`
        )
        .run(now);
      return replayed;
    });
  }

  /** Identity lookup for transport recovery; never returns another principal's payload. */
  principalsForInput(stimulusId: string): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT principal_id FROM mailbox_inputs WHERE stimulus_id = ?')
        .all(stimulusId) as Array<{ principal_id: string }>
    ).map((row) => row.principal_id);
  }

  /** The exact native turn's accepted input cohort, scoped to its principal. */
  readNativeTurnInputs(
    stimulusId: string,
    principalId: string,
    options: { afterId?: number; limit?: number } = {}
  ): { items: NativeTurnInputRef[]; nextCursor: number | null } {
    const primary = this.db
      .prepare(
        'SELECT id FROM mailbox_inputs WHERE stimulus_id=? AND principal_id=? ORDER BY id DESC LIMIT 1'
      )
      .get(stimulusId, principalId) as { id: number } | undefined;
    if (!primary) throw new Error('Native turn input is not visible to this principal');
    const receipt = this.nativeInputs.get(primary.id)?.receipt;
    if (!receipt) throw new Error('Native turn input has no accepted receipt');
    const page = this.nativeInputs.listByReceipt(receipt, principalId, options);
    if (page.inputIds.length === 0) return { items: [], nextCursor: null };
    const placeholders = page.inputIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, stimulus_id, kind, channel_key, occurred_at, status
         FROM mailbox_inputs WHERE id IN (${placeholders}) AND principal_id=?`
      )
      .all(...page.inputIds, principalId) as Array<{
      id: number;
      stimulus_id: string;
      kind: string;
      channel_key: string;
      occurred_at: number;
      status: MailboxRow['status'];
    }>;
    if (rows.length !== page.inputIds.length) {
      throw new Error('Native turn input cohort is incomplete');
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      items: page.inputIds.map((id) => {
        const row = byId.get(id)!;
        return {
          id,
          stimulusId: row.stimulus_id,
          kind: isStimulusKind(row.kind) ? row.kind : null,
          channelKey: row.channel_key,
          occurredAt: row.occurred_at,
          status: row.status,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  /** Inputs needing native/result reconciliation, never a second model execution. */
  unsettledNative(limit: number, afterId = 0): MailboxRow[] {
    return this.nativeInputs.pending(limit, afterId).map((id) => {
      const row = this.db
        .prepare('SELECT * FROM mailbox_inputs WHERE id=?')
        .get(id) as StoredRow & { status: MailboxRow['status'] };
      if (!row) throw new Error(`Native delivery input ${id} is missing`);
      const preview: unknown = JSON.parse(row.preview_json);
      if (!Array.isArray(preview) || preview.some((line) => typeof line !== 'string')) {
        throw new MailboxCorruptionError(id, new Error('Invalid input preview'));
      }
      return { ...this.hydrate(row, preview), status: row.status };
    });
  }

  /**
   * The loop took this stimulus.
   *
   * That is all this says. It is not a claim that anything was read, decided
   * or done — §4.4 is explicit that a delivery ACK is not a work receipt, and
   * there is deliberately no field here to record one in.
   */
  ack(id: number): void {
    this.stmtAck.run(this.now(), id);
  }

  /**
   * Return a claim to pending, or park it dead after MAX_ATTEMPTS. Returns the
   * resulting status so the caller can be LOUD about a dead row — a permanent
   * loss must never be silent.
   */
  retry(id: number, error: string): 'pending' | 'dead' | 'noop' {
    const result = this.stmtRetry.run(error.slice(0, 500), this.now(), id);
    if (result.changes !== 1) {
      return 'noop'; // replayStale already flipped it
    }
    const row = this.stmtRetryStatus.get(id) as { status: string } | undefined;
    return row?.status === 'dead' ? 'dead' : 'pending';
  }

  /** Park a row dead without spending an attempt. */
  quarantine(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE mailbox_inputs SET status = 'dead', last_error = ?, claimed_at = NULL
          WHERE id = ? AND status IN ('claimed', 'pending')`
      )
      .run(reason.slice(0, 500), id);
  }

  /** One row's current status; a stimulus id can name several rows. */
  inputStatus(id: number): MailboxRow['status'] | null {
    return (
      (this.stmtRetryStatus.get(id) as { status: MailboxRow['status'] } | undefined)?.status ?? null
    );
  }

  /** Cancel only inputs that have not reached the native transport, including leased waiters. */
  cancelQueued(principalId: string, reason: string): number {
    return this.db
      .prepare(
        `UPDATE mailbox_inputs SET status = 'dead', last_error = ?, claimed_at = NULL
       WHERE principal_id = ? AND status IN ('pending', 'claimed')
         AND NOT EXISTS (SELECT 1 FROM native_input_deliveries AS native
           WHERE native.input_id = mailbox_inputs.id AND native.state <> 'prepared')`
      )
      .run(reason.slice(0, 500), principalId).changes;
  }

  replayStale(olderThanMs: number, now = this.now()): number {
    return this.replayStaleDetailed(olderThanMs, now).replayed;
  }

  replayStaleDetailed(
    olderThanMs: number,
    now = this.now()
  ): { replayed: number; newlyDead: MailboxRow[] } {
    // Housekeeping rides along: acked rows age out, stale pending rows park as
    // dead (visible, bounded), and the dedupe horizon stays wide but finite —
    // no table here grows without bound.
    const stalePending = this.db
      .prepare(
        `SELECT id, stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, reply_to,
                coalesce_key, occurred_at, created_at, attempts
           FROM mailbox_inputs
          WHERE status = 'pending' AND created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state IN ('dispatching','accepted','uncertain'))
          ORDER BY id ASC`
      )
      .all(now - PENDING_RETENTION_MS) as StoredRow[];
    this.stmtPruneAcked.run(now - ACKED_RETENTION_MS);
    this.stmtPrunePending.run(now - PENDING_RETENTION_MS);
    this.stmtPruneSeen.run(now - REF_RETENTION_MS);
    const cutoff = now - olderThanMs;
    const dying = this.db
      .prepare(
        `SELECT id, stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, reply_to,
                coalesce_key, occurred_at, created_at, attempts
           FROM mailbox_inputs
          WHERE status = 'claimed' AND attempts + 1 >= ${MAX_ATTEMPTS}
            AND COALESCE(claimed_at, 0) <= ?
          AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=mailbox_inputs.id AND n.state IN ('dispatching','accepted','uncertain'))
          ORDER BY id ASC`
      )
      .all(cutoff) as StoredRow[];
    const result = this.stmtReplay.run(now, cutoff);
    const dead = (row: StoredRow, attempts: number): MailboxRow => {
      let preview: string[] = [];
      try {
        preview = JSON.parse(row.preview_json) as string[];
      } catch {
        preview = [];
      }
      return { ...this.hydrate(row, preview), status: 'dead', attempts };
    };
    return {
      replayed: result.changes,
      newlyDead: [
        ...stalePending.map((row) => dead(row, row.attempts)),
        ...dying.map((row) => dead(row, row.attempts + 1)),
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
   * Schedule a wake. The fourth job: when to come back, and for what channel.
   *
   * `mailbox_schedules` is this daemon's own alarm clock, not anyone's
   * calendar — a consumer's calendar is source data and is read through the
   * source actions (design §6.3).
   */
  scheduleWake(channelKey: string, dueAt: number): number {
    const inserted = this.db
      .prepare(`INSERT INTO mailbox_schedules (channel_key, due_at, created_at) VALUES (?, ?, ?)`)
      .run(channelKey, dueAt, this.now());
    return Number(inserted.lastInsertRowid);
  }

  /** Wakes that are due and have not fired. The caller marks them fired when it acts. */
  dueWakes(now = this.now(), limit = 50): Array<{ id: number; channelKey: string; dueAt: number }> {
    return (
      this.db
        .prepare(
          `SELECT id, channel_key, due_at FROM mailbox_schedules
            WHERE fired_at IS NULL AND due_at <= ?
            ORDER BY due_at ASC, id ASC LIMIT ?`
        )
        .all(now, Math.min(Math.max(limit, 1), 500)) as Array<{
        id: number;
        channel_key: string;
        due_at: number;
      }>
    ).map((row) => ({ id: row.id, channelKey: row.channel_key, dueAt: row.due_at }));
  }

  /** Mark a wake fired. Idempotent: a second call changes nothing. */
  markWakeFired(id: number): boolean {
    return (
      this.db
        .prepare(`UPDATE mailbox_schedules SET fired_at = ? WHERE id = ? AND fired_at IS NULL`)
        .run(this.now(), id).changes === 1
    );
  }
}
