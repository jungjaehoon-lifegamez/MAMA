import { getAdapter, initDB } from '../db-manager.js';
import type { MemoryScopeRef, MemoryTruthRow } from './types.js';

interface DecisionTruthQueryRow {
  id: string;
  topic: string;
  status: MemoryTruthRow['truth_status'];
  summary: string | null;
  decision: string;
  reasoning: string | null;
  confidence: number;
  superseded_by: string | null;
  created_at: number;
  updated_at: number | null;
  kind: MemoryTruthRow['kind'] | null;
  scope_refs: string;
}

function decisionToTruthRow(row: DecisionTruthQueryRow): MemoryTruthRow {
  return {
    memory_id: row.id,
    topic: row.topic,
    truth_status: row.status,
    effective_summary: row.summary ?? row.decision,
    effective_details: row.reasoning ?? '',
    trust_score: row.confidence,
    scope_refs: JSON.parse(row.scope_refs) as MemoryScopeRef[],
    supporting_event_ids: [],
    superseded_by: row.superseded_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    kind: row.kind ?? undefined,
  };
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

export async function queryRelevantTruth(params: {
  query: string;
  scopes: MemoryScopeRef[];
  includeHistory?: boolean;
}): Promise<MemoryTruthRow[]> {
  await initDB();
  const adapter = getAdapter();
  const scopeMatch = params.scopes
    .map(() => '(scope_filter.kind = ? AND scope_filter.external_id = ?)')
    .join(' OR ');
  const scopeFilter =
    params.scopes.length > 0
      ? `
        AND EXISTS (
          SELECT 1
          FROM memory_scope_bindings binding_filter
          JOIN memory_scopes scope_filter ON scope_filter.id = binding_filter.scope_id
          WHERE binding_filter.memory_id = d.id
            AND (${scopeMatch})
        )
      `
      : '';
  const currentFilter = params.includeHistory === true ? '' : "AND d.status = 'active'";
  const scopeParams = params.scopes.flatMap((scope) => [scope.kind, scope.id]);
  const rows = adapter
    .prepare(
      `
        SELECT d.id, d.topic, d.status, d.summary, d.decision, d.reasoning, d.confidence,
               d.superseded_by, d.created_at, d.updated_at, d.kind,
               json_group_array(json_object('kind', scope.kind, 'id', scope.external_id)) AS scope_refs
        FROM decisions d
        JOIN memory_scope_bindings binding ON binding.memory_id = d.id
        JOIN memory_scopes scope ON scope.id = binding.scope_id
        WHERE 1 = 1
          ${currentFilter}
          ${scopeFilter}
        GROUP BY d.id
        ORDER BY d.updated_at DESC, d.created_at DESC
      `
    )
    .all(...scopeParams) as DecisionTruthQueryRow[];

  return rows
    .map(decisionToTruthRow)
    .filter((row) => matchesQuery(row, params.query))
    .sort((left, right) => right.trust_score - left.trust_score);
}
