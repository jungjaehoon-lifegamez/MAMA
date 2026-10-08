import { recordScopes, type ErasedRecord } from '../identity/erased-record.js';
/**
 * The decision graph, as a caller may see it.
 *
 * The viewer drew this by reading `decisions` and `decision_edges` directly and
 * embedding fifty rows in the HTTP process. Those are reads, and a read answers
 * to the caller's scopes: every node here is a memory the caller's grant admits,
 * every edge joins two such nodes, and the totals count the same admitted set.
 * A principal that admits nothing sees an empty graph rather than the file.
 */
import { ensureMemoryScope, type DatabaseAdapter } from '../db-manager.js';

export interface GraphReadNode {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  outcome: string | null;
  confidence: number | null;
  created_at: number;
}

export interface GraphReadEdge {
  from: string;
  to: string;
  relationship: string;
  reason: string | null;
}

export interface GraphScope {
  kind: string;
  id: string;
}

/** The admitted-node clause both a node read and an edge read stand on. */
async function admittedScopeIds(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[]
): Promise<string[]> {
  return Promise.all(scopes.map((scope) => ensureMemoryScope(adapter, scope.kind, scope.id)));
}

export async function readGraphNodes(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[],
  options: { limit?: number | null; ids?: readonly string[] } = {}
): Promise<Array<GraphReadNode | ErasedRecord>> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const scopePlaceholders = scopeIds.map(() => '?').join(', ');
  const ids = options.ids ?? [];
  const idClause = ids.length > 0 ? `AND d.id IN (${ids.map(() => '?').join(', ')})` : '';
  const limit = options.limit ?? null;
  const rows = (await adapter
    .prepare(
      `SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.outcome, d.confidence, d.created_at, d.erased_at
       FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       WHERE msb.scope_id IN (${scopePlaceholders})
       ${idClause}
       ORDER BY d.created_at DESC
       ${limit === null ? '' : 'LIMIT ?'}`
    )
    .all(...scopeIds, ...ids, ...(limit === null ? [] : [limit]))) as Array<
    GraphReadNode & { erased_at: number | null }
  >;
  return rows.map(({ erased_at, ...row }) =>
    typeof erased_at === 'number'
      ? { id: row.id, scopes: recordScopes(adapter, row.id), state: 'erased' as const }
      : row
  );
}

export async function readGraphEdges(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[]
): Promise<GraphReadEdge[]> {
  if (scopes.length === 0) {
    return [];
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  // Both ends must be admitted: an edge to a memory this caller cannot read
  // would disclose that it exists, which is the read the join is here to bound.
  // Links between memories live in twin_edges; decision_edges holds the rows
  // written before links moved there.
  const rows = (await adapter
    .prepare(
      `SELECT e.from_id, e.to_id, e.relationship, e.reason
       FROM (
         SELECT from_id, to_id, relationship, reason FROM decision_edges
         UNION ALL
         SELECT subject_id, object_id, edge_type,
                COALESCE(json_extract(relation_attrs_json, '$.reason'), reason_text)
           FROM twin_edges
          WHERE subject_kind = 'memory' AND object_kind = 'memory' AND edge_type <> 'derived_from'
       ) e
       WHERE EXISTS (
               SELECT 1 FROM memory_scope_bindings b
               WHERE b.memory_id = e.from_id AND b.scope_id IN (${placeholders})
             )
         AND EXISTS (
               SELECT 1 FROM memory_scope_bindings b
               WHERE b.memory_id = e.to_id AND b.scope_id IN (${placeholders})
             )`
    )
    .all(...scopeIds, ...scopeIds)) as Array<{
    from_id: string;
    to_id: string;
    relationship: string;
    reason: string | null;
  }>;
  return rows.map((row) => ({
    from: row.from_id,
    to: row.to_id,
    relationship: row.relationship,
    reason: row.reason,
  }));
}

export async function countGraphNodes(
  adapter: DatabaseAdapter,
  scopes: readonly GraphScope[]
): Promise<number> {
  if (scopes.length === 0) {
    return 0;
  }
  const scopeIds = await admittedScopeIds(adapter, scopes);
  const placeholders = scopeIds.map(() => '?').join(', ');
  const row = (await adapter
    .prepare(
      `SELECT COUNT(DISTINCT d.id) as count FROM decisions d
       JOIN memory_scope_bindings msb ON msb.memory_id = d.id
       WHERE msb.scope_id IN (${placeholders})`
    )
    .get(...scopeIds)) as { count?: number } | undefined;
  return row?.count ?? 0;
}
