/**
 * Every durable change, and what caused it.
 *
 * This is the half the system never had. Measured over ten days: 1,471 workorders ran,
 * 1,169 of them closed as `done`, and FIVE durable effect receipts exist - all five inside
 * one eleven-minute window a week earlier. `done` meant "the run finished", not "something
 * changed", and nothing downstream could tell the difference. The peer system recorded
 * 1,080 effects over the same kind of window, every one of them naming the events that
 * caused it, and its reports are projections of that table rather than prose assembled
 * from whatever a model happened to read.
 *
 * So the rule here is narrow and total:
 *
 * A CHANGE THAT CANNOT NAME ITS CAUSE IS NOT RECORDED AS ONE. `source_event_ids` is NOT
 * NULL and must be non-empty, enforced by the schema rather than by callers remembering.
 * The tempting softening - allow an empty array "for now" - is exactly how the effect
 * table becomes a second log: it would fill with rows that prove nothing, and the first
 * question anyone asks of it ("what made this happen?") would have no answer for most of
 * them. If a write genuinely has no observed cause, that is worth discovering, not
 * papering over.
 *
 * The kinds are a closed set for the same reason the peer's are: an open `effect_kind`
 * column drifts into free text within a month, and then counting what the system actually
 * did requires reading strings. Adding a kind should be a deliberate edit here.
 *
 * ONE TABLE, BOTH NUMBERS. A change that could not name a cause is still recorded here,
 * marked `unattributed` and holding an empty cause list that the schema forces to stay
 * empty. This is not the softening warned about above - `recordEffect` still refuses a
 * causeless effect, and a writer has to call `recordUnattributedChange` by name to admit
 * one. It is here because the failure this whole redesign keeps finding is a numerator
 * with no denominator. Split across two tables, "every effect names its cause" is true by
 * construction and means nothing; in one table the ratio is a single GROUP BY.
 *
 * WHAT THIS TABLE DOES NOT YET ANSWER, stated plainly so nobody reads more into the
 * number than it holds: the "1,169 done, five receipts" comparison needs RUNS beside
 * CHANGES, and runs still live in `operator_tasks`. `changeCoverage` answers "of the
 * changes recorded, how many rest on evidence" - not "how many runs changed anything".
 * The join that answers the second question needs the run id on both sides, and only one
 * side carries it today.
 *
 * Recording the unattributed change rather than refusing the write follows the operating
 * rule this system runs under: enforce only what is irreversible or externally visible,
 * and make everything else loud. A task row is neither, so the ledger observes it.
 *
 * A CAUSE IS AN EVENT ID, and the schema checks the shape rather than trusting the helper
 * to have filtered - `[""]`, `[null]`, `[0]` and a 200 KB string are all "non-empty
 * arrays" and all lies. What the schema still cannot check is whether the id names an
 * event that exists and is readable: the event index lives in a different database. A
 * cited cause that resolves to nothing is a fabricated citation, and catching those is the
 * next thing this needs.
 */
import { createHash } from 'node:crypto';

/**
 * What kind of durable change happened. Closed on purpose - see the module
 * note. HONESTY (S2 review #5): only the task kinds have live writers today
 * (task-ledger). report_update/report_publish/memory_write/wiki_write are
 * declared surface with zero recorders - coverage claims are therefore
 * scoped to task effects; widening the ledger is named deferred work.
 */
export type EffectKind =
  | 'task_create'
  | 'task_update'
  | 'report_update'
  | 'report_publish'
  | 'memory_write'
  | 'wiki_write';

/** What it happened to. */
export type EffectTarget = 'task' | 'report_slot' | 'memory' | 'wiki_page';

/** Whether the change could name what caused it. */
export type CauseState = 'attributed' | 'unattributed';

/**
 * WHY the change happened - the closed set (S2). `event` is the only kind that
 * carries source event ids; the others are honestly id-less: a clock advanced,
 * the owner asked in chat, or a card transition cascaded. Writers pass their
 * kind explicitly - the ledger never infers.
 */
export type CauseKind = 'event' | 'owner_message' | 'clock' | 'card_transition';

/** Kinds an unattributed (id-less) change may claim. */
export type UnattributedCauseKind = Exclude<CauseKind, 'event'>;

/** Fields every durable change carries, whether or not it can name a cause. */
export interface ChangeInput {
  /**
   * The model run that produced the change, so it is traceable to a transcript.
   * Null when no model run did - a host-internal write is not made more honest by
   * inventing a run id for it.
   */
  runId?: string | null;
  /** Evidence channel this change concerns, when it concerns one. */
  channelId?: string | null;
  kind: EffectKind;
  targetType: EffectTarget;
  targetId: string;
  /** The written payload; hashed, never stored, so the ledger cannot leak content. */
  payload: unknown;
  atMs: number;
}

export interface EffectInput extends ChangeInput {
  /** Events that caused it. Must not be empty. */
  sourceEventIds: readonly string[];
}

export interface EffectRecord {
  id: number;
  runId: string | null;
  channelId: string | null;
  causeState: CauseState;
  causeKind: CauseKind;
  sourceEventIds: string[];
  kind: EffectKind;
  targetType: EffectTarget;
  targetId: string;
  payloadHash: string;
  atMs: number;
}

const EFFECT_KINDS: readonly EffectKind[] = [
  'task_create',
  'task_update',
  'report_update',
  'report_publish',
  'memory_write',
  'wiki_write',
];

const EFFECT_TARGETS: readonly EffectTarget[] = ['task', 'report_slot', 'memory', 'wiki_page'];

/** Long enough for any upstream id, short enough that the column cannot carry content. */
const MAX_EVENT_ID_LENGTH = 200;
const PAYLOAD_HASH_LENGTH = 32;

/**
 * Whether a value can serve as a cause at all.
 *
 * Callers ask before writing rather than discovering it as a constraint violation,
 * because the answer changes what they record, not whether they may proceed: a malformed
 * cause makes a change unattributed, it does not make the change illegitimate. Legacy
 * rows really do carry 400-character source identifiers, and refusing to let the operator
 * update a work item because its upstream id is the wrong shape would be enforcement
 * bought with the owner's work.
 */
export function isUsableCause(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_EVENT_ID_LENGTH;
}

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

export const EVIDENCE_EFFECTS_DDL = `
  CREATE TABLE IF NOT EXISTS evidence_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    channel_id TEXT,
    cause_state TEXT NOT NULL CHECK (cause_state IN ('attributed', 'unattributed')),
    cause_kind TEXT NOT NULL
      CHECK (cause_kind IN ('event', 'owner_message', 'clock', 'card_transition')),
    source_event_ids_json TEXT NOT NULL
      CHECK (
        json_valid(source_event_ids_json)
        AND (
          (cause_state = 'attributed' AND json_array_length(source_event_ids_json) >= 1)
          OR (cause_state = 'unattributed' AND json_array_length(source_event_ids_json) = 0)
        )
      ),
    effect_kind TEXT NOT NULL CHECK (effect_kind IN (${quoted(EFFECT_KINDS)})),
    target_type TEXT NOT NULL CHECK (target_type IN (${quoted(EFFECT_TARGETS)})),
    target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = ${PAYLOAD_HASH_LENGTH}),
    created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
  )
`;

/**
 * Per-element shape of the cause list.
 *
 * A trigger rather than a CHECK because SQLite forbids subqueries in CHECK, and checking
 * each element needs `json_each`. Without this the column enforces only "non-empty array",
 * which `[""]` and `[null]` and `[0]` all satisfy while naming nothing.
 *
 * The length bound is not cosmetic: an unbounded cause id turns an audit ledger into a
 * content channel, which is the one thing the payload is hashed to avoid.
 */
const EVIDENCE_EFFECTS_CAUSE_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS evidence_effects_cause_shape
  BEFORE INSERT ON evidence_effects
  WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.source_event_ids_json)
     WHERE json_each.type <> 'text'
        OR trim(json_each.value) = ''
        OR length(json_each.value) > ${MAX_EVENT_ID_LENGTH}
  )
  BEGIN
    SELECT RAISE(ABORT, 'evidence_effects: a cause must be a non-empty event id');
  END
`;

/**
 * kind <-> ids cross-shape. A trigger (not a table CHECK) so it applies
 * identically to fresh tables and ALTERed old ones: `event` must carry ids,
 * the id-less kinds must not - a clock that names events or an event that
 * names none is a fabricated cause either way.
 */
const EVIDENCE_EFFECTS_KIND_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS evidence_effects_kind_shape
  BEFORE INSERT ON evidence_effects
  WHEN (NEW.cause_kind = 'event' AND json_array_length(NEW.source_event_ids_json) = 0)
    OR (NEW.cause_kind <> 'event' AND json_array_length(NEW.source_event_ids_json) > 0)
  BEGIN
    SELECT RAISE(ABORT, 'evidence_effects: cause_kind and source_event_ids disagree');
  END
`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_run
     ON evidence_effects(run_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_target
     ON evidence_effects(target_type, target_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_channel
     ON evidence_effects(channel_id, created_at DESC)`,
  // Coverage is meant to be cheap enough that nobody has an excuse not to look.
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_coverage
     ON evidence_effects(created_at DESC, cause_state)`,
];

interface EffectAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid?: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}

export function ensureEffectLedger(adapter: EffectAdapter): void {
  adapter.prepare(EVIDENCE_EFFECTS_DDL).run();
  migrateCauseKind(adapter);
  adapter.prepare(EVIDENCE_EFFECTS_CAUSE_TRIGGER).run();
  adapter.prepare(EVIDENCE_EFFECTS_KIND_TRIGGER).run();
  for (const sql of INDEXES) {
    adapter.prepare(sql).run();
  }
}

/**
 * S2 migration: add cause_kind to pre-existing ledgers and backfill by
 * DISCRIMINATOR, never blanket (review #3 - "104 -> clock" would stamp owner-
 * and API-driven changes with a fabricated clock cause):
 *   attributed                          -> event  (ids >= 1, DB-checked)
 *   unattributed + temporal-effect join -> clock  (a temporal check fired)
 *   unattributed + run_id present       -> clock  (scheduled board:full run)
 *   remaining unattributed              -> owner_message (console/API writes
 *                                          carry no run and no batch)
 * ALTER ADD COLUMN with CHECK is legal SQLite (verified 2026-07-31; the
 * prohibition covers PK/UNIQUE) - no table rebuild.
 */
function migrateCauseKind(adapter: EffectAdapter): void {
  const columns = adapter.prepare(`PRAGMA table_info(evidence_effects)`).all() as Array<{
    name?: unknown;
  }>;
  if (columns.some((column) => column.name === 'cause_kind')) {
    return;
  }
  adapter
    .prepare(
      `ALTER TABLE evidence_effects ADD COLUMN cause_kind TEXT NOT NULL DEFAULT 'clock'
         CHECK (cause_kind IN ('event', 'owner_message', 'clock', 'card_transition'))`
    )
    .run();
  adapter
    .prepare(`UPDATE evidence_effects SET cause_kind = 'event' WHERE cause_state = 'attributed'`)
    .run();
  const hasTemporalTable =
    (adapter
      .prepare(
        `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='operator_temporal_effects'`
      )
      .all().length ?? 0) > 0;
  if (hasTemporalTable) {
    adapter
      .prepare(
        `UPDATE evidence_effects SET cause_kind = 'clock'
          WHERE cause_state = 'unattributed'
            AND EXISTS (SELECT 1 FROM operator_temporal_effects t
                         WHERE CAST(t.task_id AS TEXT) = evidence_effects.target_id)`
      )
      .run();
  }
  // run_id-bearing unattributed rows are scheduled runs (board:full and
  // friends): the ALTER's DEFAULT already left them 'clock', which is the
  // intended label - no UPDATE needed (a `cause_kind <> 'clock'` predicate
  // here would be dead code, review).
  adapter
    .prepare(
      hasTemporalTable
        ? `UPDATE evidence_effects SET cause_kind = 'owner_message'
             WHERE cause_state = 'unattributed' AND run_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM operator_temporal_effects t
                                WHERE CAST(t.task_id AS TEXT) = evidence_effects.target_id)`
        : `UPDATE evidence_effects SET cause_kind = 'owner_message'
             WHERE cause_state = 'unattributed' AND run_id IS NULL`
    )
    .run();
}

export class EffectWithoutCauseError extends Error {
  constructor(kind: EffectKind, targetId: string) {
    super(
      `Refusing to record ${kind} on ${targetId} with no source events: a change that cannot name its cause is not an effect.`
    );
    this.name = 'EffectWithoutCauseError';
  }
}

/** Stable hash of what was written. The ledger proves a change happened, not what it said. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex')
    .slice(0, PAYLOAD_HASH_LENGTH);
}

/**
 * Record a durable change.
 *
 * Throws rather than returning a failure when the cause is missing. A caller that wrote
 * something and then could not say why must not proceed as if the write were accounted
 * for - silently skipping the ledger row is how 1,169 runs closed as `done` while five
 * receipts existed.
 */
export function recordEffect(adapter: EffectAdapter, input: EffectInput): number {
  const sourceEventIds = [
    ...new Set(input.sourceEventIds.filter(isUsableCause).map((id) => id.trim())),
  ];
  if (sourceEventIds.length === 0) {
    throw new EffectWithoutCauseError(input.kind, input.targetId);
  }
  return insertChange(adapter, input, 'event', sourceEventIds);
}

/**
 * Record a durable change that could not name what caused it.
 *
 * Deliberately a separate function with an uncomfortable name. Every call is an admission
 * that the system changed something it cannot explain, and the point is that the count of
 * these is visible next to the count of real effects rather than absent from both.
 */
export function recordUnattributedChange(
  adapter: EffectAdapter,
  input: ChangeInput,
  causeKind: UnattributedCauseKind
): number {
  return insertChange(adapter, input, causeKind, []);
}

function insertChange(
  adapter: EffectAdapter,
  input: ChangeInput,
  causeKind: CauseKind,
  sourceEventIds: readonly string[]
): number {
  const result = adapter
    .prepare(
      `INSERT INTO evidence_effects
         (run_id, channel_id, cause_state, cause_kind, source_event_ids_json,
          effect_kind, target_type, target_id, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.runId ?? null,
      input.channelId ?? null,
      causeKind === 'event' ? 'attributed' : 'unattributed',
      causeKind,
      JSON.stringify(sourceEventIds),
      input.kind,
      input.targetType,
      input.targetId,
      payloadHash(input.payload),
      input.atMs
    );
  return Number(result.lastInsertRowid ?? 0);
}

export interface EffectQuery {
  runId?: string;
  targetType?: EffectTarget;
  targetId?: string;
  causeState?: CauseState;
  sinceMs?: number;
  limit?: number;
}

/** Read effects back, newest first - the substrate a report projects from. */
export function listEffects(adapter: EffectAdapter, query: EffectQuery = {}): EffectRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.runId !== undefined) {
    clauses.push('run_id = ?');
    params.push(query.runId);
  }
  if (query.targetType !== undefined) {
    clauses.push('target_type = ?');
    params.push(query.targetType);
  }
  if (query.targetId !== undefined) {
    clauses.push('target_id = ?');
    params.push(query.targetId);
  }
  if (query.causeState !== undefined) {
    clauses.push('cause_state = ?');
    params.push(query.causeState);
  }
  if (query.sinceMs !== undefined) {
    clauses.push('created_at >= ?');
    params.push(query.sinceMs);
  }
  params.push(Math.min(Math.max(query.limit ?? 200, 1), 1000));

  const rows = adapter
    .prepare(
      `SELECT * FROM evidence_effects
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    channelId: typeof row.channel_id === 'string' ? row.channel_id : null,
    causeState: String(row.cause_state) as CauseState,
    causeKind: String(row.cause_kind) as CauseKind,
    sourceEventIds: JSON.parse(String(row.source_event_ids_json)) as string[],
    kind: String(row.effect_kind) as EffectKind,
    targetType: String(row.target_type) as EffectTarget,
    targetId: String(row.target_id),
    payloadHash: String(row.payload_hash),
    atMs: Number(row.created_at),
  }));
}

export interface ChangeCoverage {
  /** Changes that named the events behind them. */
  attributed: number;
  /** Changes the system made and could not explain. */
  unattributed: number;
}

/**
 * How much of what the system changed rests on evidence.
 *
 * The single number this ledger exists to make answerable, and the one the previous shape
 * of the system could not produce at all.
 */
export function changeCoverage(
  adapter: EffectAdapter,
  sinceMs?: number,
  targetType?: EffectTarget
): ChangeCoverage {
  // Coverage must describe the same population as the rows a caller is looking at, or the
  // two halves of one answer disagree and the reader cannot tell which is wrong.
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (sinceMs !== undefined) {
    clauses.push('created_at >= ?');
    params.push(sinceMs);
  }
  if (targetType !== undefined) {
    clauses.push('target_type = ?');
    params.push(targetType);
  }
  const rows = adapter
    .prepare(
      `SELECT cause_state, COUNT(*) AS n FROM evidence_effects
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        GROUP BY cause_state`
    )
    .all(...params) as Array<Record<string, unknown>>;
  const coverage: ChangeCoverage = { attributed: 0, unattributed: 0 };
  for (const row of rows) {
    if (row.cause_state === 'attributed') coverage.attributed = Number(row.n);
    if (row.cause_state === 'unattributed') coverage.unattributed = Number(row.n);
  }
  return coverage;
}
