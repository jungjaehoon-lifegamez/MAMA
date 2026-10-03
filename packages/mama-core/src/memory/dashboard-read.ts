/**
 * Listings and rollups over the memory a caller may see.
 *
 * The dashboard asked these of the database directly: which decisions are
 * active and going stale, what changed recently, which projects are busy, and
 * what one project holds. They are reads, so they answer to the caller's
 * scopes — the same join every other admitted read stands on. A principal that
 * admits nothing gets empty lists rather than the whole file.
 */
import { ensureMemoryScope, type DatabaseAdapter } from '../db-manager.js';

export interface DecisionListingRow {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  status: string | null;
  confidence?: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRollup {
  project: string;
  activeDecisions: number;
  lastActivity: number;
}

export interface ReadScope {
  kind: string;
  id: string;
}

async function admittedScopeIds(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[]
): Promise<string[]> {
  return Promise.all(scopes.map((scope) => ensureMemoryScope(adapter, scope.kind, scope.id)));
}

/**
 * Recent or stale decisions under the admitted scopes.
 *
 * `order: 'stale'` puts the least recently touched first — what the dashboard
 * calls an alert. `order: 'recent'` is the activity feed. `status` narrows to
 * one lifecycle state when the caller names it.
 */
export async function readDecisionListing(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[],
  options: { status?: string; order?: 'recent' | 'stale'; limit?: number } = {}
): Promise<DecisionListingRow[]> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  const status = typeof options.status === 'string' ? options.status.trim() : '';
  const direction = options.order === 'stale' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  return (await adapter
    .prepare(
      `SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.status, d.confidence,
              d.created_at, d.updated_at
       FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       WHERE msb.scope_id IN (${placeholders})
       ${status ? 'AND d.status = ?' : ''}
       ORDER BY d.updated_at ${direction}
       LIMIT ?`
    )
    .all(...scopeIds, ...(status ? [status] : []), limit)) as DecisionListingRow[];
}

export interface SavedTimelineRow {
  id: string;
  kind: string | null;
  recordKind: string | null;
  status: string | null;
  topic: string;
  summary: string;
  createdAt: number;
  eventDatetime: number | null;
  /** The owner message, delta or report turn that wrote the record, when a turn did. */
  sourceMessageRef: string | null;
  /** The work item a revision record belongs to, which revision it is, and what it did. */
  commitmentId: string | null;
  revision: number | null;
  operation: 'create' | 'revise' | 'withdraw' | null;
  /** The item's title as its latest titled revision set it. */
  itemTitle: string | null;
}

export interface SavedTimelinePage {
  records: SavedTimelineRow[];
  nextCursor: string | null;
}

/**
 * What was written when, under the admitted scopes: newest written first, inside a window on
 * write time (since inclusive, until exclusive), a page at a time. Paging keys on the write time
 * and the id, so a page never repeats or skips a record that shares a timestamp.
 */
export async function readSavedTimeline(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[],
  options: { since?: number; until?: number; cursor?: string; limit?: number } = {}
): Promise<SavedTimelinePage> {
  if (scopes.length === 0) {
    return { records: [], nextCursor: null };
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 500);
  const after = options.cursor === undefined ? null : parseTimelineCursor(options.cursor);
  const rows = (await adapter
    .prepare(
      `SELECT d.id, d.kind, d.record_kind, d.status, d.topic,
              COALESCE(d.summary, d.decision) AS summary, d.created_at, d.event_datetime,
              CASE WHEN json_valid(d.provenance_json)
                   THEN json_extract(d.provenance_json, '$.source_message_ref') END
                AS source_message_ref,
              a.commitment_id, a.revision, a.operation,
              (SELECT json_extract(titled.set_json, '$.title')
               FROM commitment_assignments titled
               WHERE titled.commitment_id = a.commitment_id
                 AND json_extract(titled.set_json, '$.title') IS NOT NULL
               ORDER BY titled.revision DESC
               LIMIT 1) AS item_title
       FROM decisions d
       LEFT JOIN commitment_assignments a ON a.record_id = d.id
       WHERE EXISTS (
               SELECT 1 FROM memory_scope_bindings msb
               WHERE msb.memory_id = d.id AND msb.scope_id IN (${placeholders})
             )
         ${options.since === undefined ? '' : 'AND d.created_at >= ?'}
         ${options.until === undefined ? '' : 'AND d.created_at < ?'}
         ${after === null ? '' : 'AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?))'}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ?`
    )
    .all(
      ...scopeIds,
      ...(options.since === undefined ? [] : [options.since]),
      ...(options.until === undefined ? [] : [options.until]),
      ...(after === null ? [] : [after.createdAt, after.createdAt, after.id]),
      limit + 1
    )) as Array<{
    id: string;
    kind: string | null;
    record_kind: string | null;
    status: string | null;
    topic: string;
    summary: string;
    created_at: number;
    event_datetime: number | null;
    source_message_ref: string | null;
    commitment_id: string | null;
    revision: number | null;
    operation: SavedTimelineRow['operation'];
    item_title: string | null;
  }>;
  const records = rows.slice(0, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    recordKind: row.record_kind,
    status: row.status,
    topic: row.topic,
    summary: row.summary,
    createdAt: row.created_at,
    eventDatetime: row.event_datetime,
    sourceMessageRef: row.source_message_ref,
    commitmentId: row.commitment_id,
    revision: row.revision,
    operation: row.operation,
    itemTitle: row.item_title,
  }));
  const last = records.at(-1);
  return {
    records,
    nextCursor: rows.length > limit && last !== undefined ? `${last.createdAt}|${last.id}` : null,
  };
}

function parseTimelineCursor(cursor: string): { createdAt: number; id: string } {
  const split = cursor.indexOf('|');
  const createdAt = Number(cursor.slice(0, split));
  if (split < 1 || !Number.isSafeInteger(createdAt) || split === cursor.length - 1) {
    throw new Error(`memory.read:timeline cursor is not one this read returned: ${cursor}`);
  }
  return { createdAt, id: cursor.slice(split + 1) };
}

/** Per-project active-decision counts and last activity, over admitted scopes. */
export async function readProjectRollups(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[]
): Promise<ProjectRollup[]> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  return (await adapter
    .prepare(
      `SELECT ms.external_id AS project,
              COUNT(DISTINCT d.id) AS activeDecisions,
              MAX(d.updated_at) AS lastActivity
       FROM memory_scopes ms
       JOIN memory_scope_bindings msb ON msb.scope_id = ms.id
       JOIN decisions d ON d.id = msb.memory_id
       WHERE ms.kind = 'project'
         AND d.status = 'active'
         AND EXISTS (
               SELECT 1 FROM memory_scope_bindings admitted
               WHERE admitted.memory_id = d.id AND admitted.scope_id IN (${placeholders})
             )
       GROUP BY ms.external_id
       ORDER BY lastActivity DESC`
    )
    .all(...scopeIds)) as ProjectRollup[];
}

/** What one project holds, still bounded by what the caller admits. */
export async function readProjectDecisions(
  adapter: DatabaseAdapter,
  scopes: readonly ReadScope[],
  project: string,
  limit = 50
): Promise<DecisionListingRow[]> {
  if (scopes.length === 0 || project.trim() === '') {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
  return (await adapter
    .prepare(
      `SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.status, d.confidence,
              d.created_at, d.updated_at
       FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       JOIN memory_scopes ms ON ms.id = msb.scope_id
       WHERE ms.kind = 'project'
         AND ms.external_id = ?
         AND EXISTS (
               SELECT 1 FROM memory_scope_bindings admitted
               WHERE admitted.memory_id = d.id AND admitted.scope_id IN (${placeholders})
             )
       ORDER BY d.updated_at DESC
       LIMIT ?`
    )
    .all(project, ...scopeIds, bounded)) as DecisionListingRow[];
}
