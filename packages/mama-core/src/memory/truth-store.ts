import { getAdapter, initDB } from '../db-manager.js';
import type { MemoryScopeRef, MemoryTruthRow } from './types.js';

function deserializeTruthRow(row: Record<string, unknown>): MemoryTruthRow {
  return {
    memory_id: String(row.memory_id),
    topic: String(row.topic),
    truth_status: row.truth_status as MemoryTruthRow['truth_status'],
    effective_summary: String(row.effective_summary),
    effective_details: String(row.effective_details),
    trust_score: Number(row.trust_score),
    scope_refs: JSON.parse(String(row.scope_refs)) as MemoryScopeRef[],
    supporting_event_ids: JSON.parse(String(row.supporting_event_ids)) as string[],
    superseded_by: typeof row.superseded_by === 'string' ? row.superseded_by : undefined,
    contradicted_by:
      typeof row.contradicted_by === 'string'
        ? (JSON.parse(row.contradicted_by) as string[])
        : undefined,
    created_at: typeof row.created_at === 'number' ? row.created_at : undefined,
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : undefined,
    kind: typeof row.kind === 'string' ? (row.kind as MemoryTruthRow['kind']) : undefined,
  };
}

function matchesScopes(row: MemoryTruthRow, scopes: MemoryScopeRef[]): boolean {
  if (scopes.length === 0) {
    return true;
  }

  return row.scope_refs.some((scopeRef) =>
    scopes.some((scope) => scope.kind === scopeRef.kind && scope.id === scopeRef.id)
  );
}

function matchesQuery(row: MemoryTruthRow, query: string): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[\s,.!?;:()[\]{}"']+/)
    .filter((token) => token.length > 1);
  const haystack = [row.topic, row.effective_summary, row.effective_details]
    .join(' ')
    .toLowerCase();

  return tokens.length === 0
    ? haystack.includes(query.toLowerCase())
    : tokens.some((token) => haystack.includes(token));
}

export async function projectMemoryTruth(row: MemoryTruthRow): Promise<void> {
  await initDB();
  const adapter = getAdapter();
  const now = Date.now();

  adapter
    .prepare(
      `
        INSERT OR REPLACE INTO memory_truth (
          memory_id, topic, truth_status, effective_summary, effective_details, trust_score,
          scope_refs, supporting_event_ids, superseded_by, contradicted_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM memory_truth WHERE memory_id = ?), ?), ?)
      `
    )
    .run(
      row.memory_id,
      row.topic,
      row.truth_status,
      row.effective_summary,
      row.effective_details,
      row.trust_score,
      JSON.stringify(row.scope_refs),
      JSON.stringify(row.supporting_event_ids),
      row.superseded_by ?? null,
      row.contradicted_by ? JSON.stringify(row.contradicted_by) : null,
      row.memory_id,
      now,
      now
    );
}

export async function queryTruthByTopic(
  topic: string,
  options: { includeHistory?: boolean } = {}
): Promise<MemoryTruthRow[]> {
  await initDB();
  const adapter = getAdapter();
  const rows = adapter
    .prepare(
      `
        SELECT mt.memory_id, mt.topic, mt.truth_status, mt.effective_summary, mt.effective_details, mt.trust_score,
               mt.scope_refs, mt.supporting_event_ids, mt.superseded_by, mt.contradicted_by, mt.created_at, mt.updated_at,
               d.kind
        FROM memory_truth mt
        LEFT JOIN decisions d ON d.id = mt.memory_id
        WHERE mt.topic = ?
        ORDER BY mt.updated_at DESC
      `
    )
    .all(topic) as Record<string, unknown>[];

  return rows
    .map(deserializeTruthRow)
    .filter(
      (row) =>
        options.includeHistory === true ||
        (row.truth_status !== 'quarantined' &&
          row.truth_status !== 'superseded' &&
          row.truth_status !== 'contradicted')
    );
}

export async function queryRelevantTruth(params: {
  query: string;
  scopes: MemoryScopeRef[];
  includeHistory?: boolean;
}): Promise<MemoryTruthRow[]> {
  await initDB();
  const adapter = getAdapter();
  const rows = adapter
    .prepare(
      `
        SELECT mt.memory_id, mt.topic, mt.truth_status, mt.effective_summary, mt.effective_details, mt.trust_score,
               mt.scope_refs, mt.supporting_event_ids, mt.superseded_by, mt.contradicted_by, mt.created_at, mt.updated_at,
               d.kind
        FROM memory_truth mt
        LEFT JOIN decisions d ON d.id = mt.memory_id
        ORDER BY mt.updated_at DESC
      `
    )
    .all() as Record<string, unknown>[];

  return rows
    .map(deserializeTruthRow)
    .filter((row) => matchesScopes(row, params.scopes))
    .filter((row) => matchesQuery(row, params.query))
    .filter(
      (row) =>
        params.includeHistory === true ||
        (row.truth_status !== 'quarantined' &&
          row.truth_status !== 'superseded' &&
          row.truth_status !== 'contradicted')
    )
    .sort((left, right) => right.trust_score - left.trust_score);
}
