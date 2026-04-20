import { getAdapter, initDB } from '../db-manager.js';
import type { MemoryRecord, MemoryScopeRef } from '../memory/types.js';
import { projectEntityToRecallSummary } from './projection.js';
import { resolveReadIdentity } from './read-identity.js';
import { EntityMergeError, resolveCanonicalEntityId } from './store.js';
import type { EntityAlias, EntityNode, EntityTimelineEvent } from './types.js';

function mapNode(row: Record<string, unknown>): EntityNode {
  return {
    id: String(row.id),
    kind: row.kind as EntityNode['kind'],
    preferred_label: String(row.preferred_label),
    status: row.status as EntityNode['status'],
    scope_kind:
      typeof row.scope_kind === 'string' ? (row.scope_kind as EntityNode['scope_kind']) : null,
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

function escapeLikeQuery(query: string): string {
  return query.replace(/[\\%_]/g, '\\$&');
}

export async function queryCanonicalEntities(
  query: string,
  scopes: MemoryScopeRef[],
  options: { limit?: number } = {}
): Promise<MemoryRecord[]> {
  await initDB();
  const adapter = getAdapter();
  const escapedQuery = escapeLikeQuery(query);

  // Match aliases and labels regardless of whether the owning node is merged,
  // then chain-walk each match to its canonical terminal. Without this,
  // searching by the old name of a merged entity returns nothing because the
  // filter `n.status='active' AND n.merged_into IS NULL` would drop the
  // source row. Matches the read-time chain-walking approach in the canonical
  // entity ontology implementation plan.
  const matchedRows = adapter
    .prepare(
      `
        SELECT DISTINCT n.id AS matched_id
        FROM entity_nodes n
        LEFT JOIN entity_aliases a ON a.entity_id = n.id
        LEFT JOIN entity_lineage_links l ON l.canonical_entity_id = n.id AND l.status = 'active'
        LEFT JOIN entity_observations o ON o.id = l.entity_observation_id
        WHERE (
          lower(n.preferred_label) LIKE '%' || lower(?) || '%' ESCAPE '\\'
          OR lower(COALESCE(a.label, '')) LIKE '%' || lower(?) || '%' ESCAPE '\\'
          OR lower(COALESCE(o.surface_form, '')) LIKE '%' || lower(?) || '%' ESCAPE '\\'
        )
      `
    )
    .all(escapedQuery, escapedQuery, escapedQuery) as Array<{ matched_id: string }>;

  const canonicalIdSet = new Set<string>();
  for (const match of matchedRows) {
    try {
      canonicalIdSet.add(resolveCanonicalEntityId(adapter, match.matched_id));
    } catch (err) {
      // Cycle or missing node — skip this match rather than poison the whole
      // recall. Merge integrity errors are surfaced elsewhere (the review
      // handler 409 path) where the user can actually act on them.
      if (!(err instanceof EntityMergeError)) {
        throw err;
      }
    }
  }

  if (canonicalIdSet.size === 0) {
    return [];
  }

  const canonicalIds = Array.from(canonicalIdSet);
  const placeholders = canonicalIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM entity_nodes
        WHERE id IN (${placeholders})
          AND status = 'active'
          AND merged_into IS NULL
        ORDER BY updated_at DESC
      `
    )
    .all(...canonicalIds) as Array<Record<string, unknown>>;

  const scopedRows =
    scopes.length === 0
      ? rows
      : rows.filter(
          (row) =>
            // Fix 2 part B (P0): globally-scoped entities are not bound to
            // any narrower scope and must surface in every scoped query.
            // Without this passthrough, switching person observations from
            // channel-scope to global-scope (Fix 2 part A in
            // history-extractor.ts) would make persons invisible to scoped
            // recall callers, breaking the time-travel use case the fix is
            // meant to enable. scope_id is intentionally not compared for
            // globals — the global predicate is `scope_kind='global'` alone.
            row.scope_kind === 'global' ||
            scopes.some((scope) => scope.kind === row.scope_kind && row.scope_id === scope.id)
        );

  const limitedRows = scopedRows.slice(0, options.limit ?? 10);
  const nodeLookup = Object.fromEntries(limitedRows.map((row) => [String(row.id), mapNode(row)]));
  const entityIds = limitedRows.map((row) => String(row.id));

  const aliasesByEntity = new Map<string, EntityAlias[]>();
  const latestTimelineByEntity = new Map<string, EntityTimelineEvent>();

  if (entityIds.length > 0) {
    const placeholders = entityIds.map(() => '?').join(', ');
    const aliasRows = adapter
      .prepare(
        `
        SELECT * FROM entity_aliases
        WHERE entity_id IN (${placeholders})
        ORDER BY entity_id ASC, created_at ASC
      `
      )
      .all(...entityIds) as Array<Record<string, unknown>>;
    for (const row of aliasRows) {
      const alias = mapAlias(row);
      const existing = aliasesByEntity.get(alias.entity_id) ?? [];
      existing.push(alias);
      aliasesByEntity.set(alias.entity_id, existing);
    }

    const timelineRows = adapter
      .prepare(
        `
        SELECT *
        FROM (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY entity_id
                   ORDER BY COALESCE(observed_at, created_at) DESC
                 ) AS row_num
          FROM entity_timeline_events
          WHERE entity_id IN (${placeholders})
        )
        WHERE row_num = 1
      `
      )
      .all(...entityIds) as Array<Record<string, unknown>>;
    for (const row of timelineRows) {
      const timeline = mapTimeline(row);
      latestTimelineByEntity.set(timeline.entity_id, timeline);
    }
  }

  const result: MemoryRecord[] = [];
  for (const row of limitedRows) {
    const node = mapNode(row);
    const projected = projectEntityToRecallSummary(
      node,
      aliasesByEntity.get(node.id) ?? [],
      latestTimelineByEntity.get(node.id) ?? null,
      { nodeLookup }
    );
    projected.read_identity = resolveReadIdentity(projected, [
      { id: node.id, label: node.preferred_label, kind: node.kind },
    ]);
    result.push(projected);
  }

  return result;
}
