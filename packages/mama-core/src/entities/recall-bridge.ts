import { getAdapter, initDB } from '../db-manager.js';
import type { MemoryRecord, MemoryScopeRef } from '../memory/types.js';
import { projectEntityToRecallSummary } from './projection.js';
import type { EntityAlias, EntityNode, EntityTimelineEvent } from './types.js';

function mapNode(row: Record<string, unknown>): EntityNode {
  return {
    id: String(row.id),
    kind: row.kind as EntityNode['kind'],
    preferred_label: String(row.preferred_label),
    status: row.status as EntityNode['status'],
    scope_kind: row.scope_kind as EntityNode['scope_kind'],
    scope_id: typeof row.scope_id === 'string' ? row.scope_id : null,
    merged_into: typeof row.merged_into === 'string' ? row.merged_into : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function mapAlias(row: Record<string, unknown>): EntityAlias {
  return {
    id: String(row.id),
    entity_id: String(row.entity_id),
    label: String(row.label),
    normalized_label: String(row.normalized_label),
    lang: typeof row.lang === 'string' ? row.lang : null,
    script: typeof row.script === 'string' ? row.script : null,
    label_type: row.label_type as EntityAlias['label_type'],
    source_type: String(row.source_type),
    source_ref: typeof row.source_ref === 'string' ? row.source_ref : null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    status: row.status as EntityAlias['status'],
    created_at: Number(row.created_at),
  };
}

function mapTimeline(row: Record<string, unknown>): EntityTimelineEvent {
  return {
    id: String(row.id),
    entity_id: String(row.entity_id),
    event_type: String(row.event_type),
    valid_from: typeof row.valid_from === 'number' ? row.valid_from : null,
    valid_to: typeof row.valid_to === 'number' ? row.valid_to : null,
    observed_at: typeof row.observed_at === 'number' ? row.observed_at : null,
    source_ref: typeof row.source_ref === 'string' ? row.source_ref : null,
    summary: String(row.summary),
    details: typeof row.details === 'string' ? row.details : null,
    created_at: Number(row.created_at),
  };
}

export async function queryCanonicalEntities(
  query: string,
  scopes: MemoryScopeRef[],
  options: { limit?: number } = {}
): Promise<MemoryRecord[]> {
  await initDB();
  const adapter = getAdapter();
  const rows = adapter
    .prepare(
      `
        SELECT DISTINCT n.*
        FROM entity_nodes n
        LEFT JOIN entity_aliases a ON a.entity_id = n.id
        WHERE (
          lower(n.preferred_label) LIKE '%' || lower(?) || '%'
          OR lower(COALESCE(a.label, '')) LIKE '%' || lower(?) || '%'
        )
        ORDER BY n.updated_at DESC
      `
    )
    .all(query, query) as Array<Record<string, unknown>>;

  const scopedRows =
    scopes.length === 0
      ? rows
      : rows.filter((row) =>
          scopes.some(
            (scope) => scope.kind === row.scope_kind && scope.id === (row.scope_id ?? scope.id)
          )
        );

  const limitedRows = scopedRows.slice(0, options.limit ?? 10);
  const nodeLookup = Object.fromEntries(limitedRows.map((row) => [String(row.id), mapNode(row)]));

  const result: MemoryRecord[] = [];
  for (const row of limitedRows) {
    const node = mapNode(row);
    const aliases = adapter
      .prepare('SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY created_at ASC')
      .all(node.id) as Array<Record<string, unknown>>;
    const latestEvent = adapter
      .prepare(
        'SELECT * FROM entity_timeline_events WHERE entity_id = ? ORDER BY COALESCE(observed_at, created_at) DESC LIMIT 1'
      )
      .get(node.id) as Record<string, unknown> | undefined;

    result.push(
      projectEntityToRecallSummary(
        node,
        aliases.map((alias) => mapAlias(alias)),
        latestEvent ? mapTimeline(latestEvent) : null,
        { nodeLookup }
      )
    );
  }

  return result;
}
