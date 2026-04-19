import { getAdapter, initDB } from '../db-manager.js';
import { loadLinkedDecisionCounts } from './entity-linked-decision-counts.js';
import { EntityMergeError, resolveCanonicalEntityId } from './store.js';
import type { EntityNode } from './types.js';

interface SearchCanonicalEntitiesInput {
  query: string;
  limit: number;
  cursor?: string | null;
}

interface EntitySearchRow {
  id: string;
  kind: EntityNode['kind'];
  preferred_label: string;
  scope_kind: EntityNode['scope_kind'];
  scope_id: string | null;
  score: number;
  linked_decision_count: number;
}

interface SearchCanonicalEntitiesResult {
  entities: EntitySearchRow[];
  next_cursor: string | null;
}

function normalizeSearchLabel(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function buildSearchCollapseKey(row: EntitySearchRow): string {
  return JSON.stringify([
    row.kind,
    row.scope_kind,
    row.scope_id ?? '',
    normalizeSearchLabel(row.preferred_label),
  ]);
}

function escapeLikeQuery(query: string): string {
  return query.replace(/[\\%_]/g, '\\$&');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const decoded = Number(Buffer.from(cursor, 'base64').toString('utf8'));
    return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

export async function searchCanonicalEntities(
  input: SearchCanonicalEntitiesInput
): Promise<SearchCanonicalEntitiesResult> {
  await initDB();
  const adapter = getAdapter();
  const query = input.query.trim();
  if (!query) {
    return { entities: [], next_cursor: null };
  }

  const escaped = escapeLikeQuery(query);
  const rows = adapter
    .prepare(
      `
        SELECT
          n.id AS matched_id,
          n.preferred_label,
          n.kind,
          n.scope_kind,
          n.scope_id,
          a.label AS alias_label,
          o.surface_form AS observation_surface_form
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
    .all(escaped, escaped, escaped) as Array<{
    matched_id: string;
    preferred_label: string;
    kind: EntityNode['kind'];
    scope_kind: EntityNode['scope_kind'];
    scope_id: string | null;
    alias_label: string | null;
    observation_surface_form: string | null;
  }>;

  const canonicalRows = new Map<string, EntitySearchRow>();
  for (const row of rows) {
    let canonicalId: string;
    try {
      canonicalId = resolveCanonicalEntityId(adapter, row.matched_id);
    } catch (error) {
      if (error instanceof EntityMergeError) {
        continue;
      }
      throw error;
    }

    const canonical = adapter
      .prepare(
        `
          SELECT id, kind, preferred_label, scope_kind, scope_id
          FROM entity_nodes
          WHERE id = ?
            AND status = 'active'
            AND merged_into IS NULL
        `
      )
      .get(canonicalId) as
      | {
          id: string;
          kind: EntityNode['kind'];
          preferred_label: string;
          scope_kind: EntityNode['scope_kind'];
          scope_id: string | null;
        }
      | undefined;
    if (!canonical) {
      continue;
    }

    const score = row.preferred_label.toLowerCase().includes(query.toLowerCase())
      ? 3
      : row.alias_label?.toLowerCase().includes(query.toLowerCase())
        ? 2
        : 1;
    const existing = canonicalRows.get(canonical.id);
    if (!existing || score > existing.score) {
      canonicalRows.set(canonical.id, {
        id: canonical.id,
        kind: canonical.kind,
        preferred_label: canonical.preferred_label,
        scope_kind: canonical.scope_kind,
        scope_id: canonical.scope_id,
        score,
        linked_decision_count: 0,
      });
    }
  }

  const collapsedRows = new Map<string, EntitySearchRow>();
  for (const row of canonicalRows.values()) {
    const key = buildSearchCollapseKey(row);
    const existing = collapsedRows.get(key);
    if (
      !existing ||
      row.score > existing.score ||
      (row.score === existing.score && row.id.localeCompare(existing.id) < 0)
    ) {
      collapsedRows.set(key, row);
    }
  }

  const sorted = Array.from(collapsedRows.values()).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const labelCompare = left.preferred_label.localeCompare(right.preferred_label);
    if (labelCompare !== 0) {
      return labelCompare;
    }
    return left.id.localeCompare(right.id);
  });

  const offset = decodeCursor(input.cursor);
  const limit = Math.max(1, input.limit);
  const linkedCounts = loadLinkedDecisionCounts(
    adapter,
    sorted.map((row) => row.id)
  );
  const entities = sorted.slice(offset, offset + limit).map((row) => ({
    ...row,
    linked_decision_count: linkedCounts.get(row.id) ?? 0,
  }));
  const next_cursor = offset + limit < sorted.length ? encodeCursor(offset + limit) : null;

  return { entities, next_cursor };
}
