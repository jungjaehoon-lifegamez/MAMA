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
 */
import { createHash } from 'node:crypto';

/** What kind of durable change happened. Closed on purpose - see the module note. */
export type EffectKind =
  | 'task_create'
  | 'task_update'
  | 'report_update'
  | 'report_publish'
  | 'memory_write'
  | 'wiki_write';

/** What it happened to. */
export type EffectTarget = 'task' | 'report_slot' | 'memory' | 'wiki_page';

export interface EffectInput {
  /** The model run that produced the change, so an effect is traceable to a transcript. */
  runId: string;
  /** Evidence channel this change concerns, when it concerns one. */
  channelId?: string | null;
  /** Events that caused it. Must not be empty. */
  sourceEventIds: readonly string[];
  kind: EffectKind;
  targetType: EffectTarget;
  targetId: string;
  /** The written payload; hashed, never stored, so the ledger cannot leak content. */
  payload: unknown;
  atMs: number;
}

export interface EffectRecord {
  id: number;
  runId: string;
  channelId: string | null;
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

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

export const EVIDENCE_EFFECTS_DDL = `
  CREATE TABLE IF NOT EXISTS evidence_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    channel_id TEXT,
    source_event_ids_json TEXT NOT NULL
      CHECK (json_valid(source_event_ids_json) AND json_array_length(source_event_ids_json) >= 1),
    effect_kind TEXT NOT NULL CHECK (effect_kind IN (${quoted(EFFECT_KINDS)})),
    target_type TEXT NOT NULL CHECK (target_type IN (${quoted(EFFECT_TARGETS)})),
    target_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_run
     ON evidence_effects(run_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_target
     ON evidence_effects(target_type, target_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_effects_channel
     ON evidence_effects(channel_id, created_at DESC)`,
];

interface EffectAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid?: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}

export function ensureEffectLedger(adapter: EffectAdapter): void {
  adapter.prepare(EVIDENCE_EFFECTS_DDL).run();
  for (const sql of INDEXES) {
    adapter.prepare(sql).run();
  }
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
    .slice(0, 32);
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
  const sourceEventIds = [...new Set(input.sourceEventIds.filter((id) => id.trim().length > 0))];
  if (sourceEventIds.length === 0) {
    throw new EffectWithoutCauseError(input.kind, input.targetId);
  }
  const result = adapter
    .prepare(
      `INSERT INTO evidence_effects
         (run_id, channel_id, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.runId,
      input.channelId ?? null,
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
    runId: String(row.run_id),
    channelId: typeof row.channel_id === 'string' ? row.channel_id : null,
    sourceEventIds: JSON.parse(String(row.source_event_ids_json)) as string[],
    kind: String(row.effect_kind) as EffectKind,
    targetType: String(row.target_type) as EffectTarget,
    targetId: String(row.target_id),
    payloadHash: String(row.payload_hash),
    atMs: Number(row.created_at),
  }));
}
