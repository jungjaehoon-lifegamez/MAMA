import { getAdapter } from '../db-manager.js';
import { loadLinkedDecisionCounts } from './entity-linked-decision-counts.js';
import type { EntityNode } from './types.js';

export interface CanonicalEntityOrphanRow {
  entity_id: string;
  title: string;
  kind: EntityNode['kind'];
  scope_kind: EntityNode['scope_kind'];
  scope_id: string | null;
  scope_label: string;
  created_at: number;
  linked_decision_count: number;
  evidence_summary: {
    lineage_rows: number;
    raw_evidence_rows: number;
    last_seen_at: number | null;
  };
}

interface ReadAdapter {
  prepare(sql: string): {
    all: (...params: unknown[]) => unknown[];
  };
}

function buildScopeLabel(
  scopeKind: EntityNode['scope_kind'],
  scopeId: string | null | undefined
): string {
  return scopeKind ? `${scopeKind}:${scopeId ?? ''}` : 'global';
}

function isNoisyCanonicalEntity(row: Pick<CanonicalEntityOrphanRow, 'kind' | 'title'>): boolean {
  const label = row.title.trim().toLowerCase();
  if (row.kind === 'person') {
    return label === 'user' || label === 'claude';
  }
  if (row.kind === 'project') {
    return label === 'workspace';
  }
  return false;
}

function compareOrphanRows(
  left: CanonicalEntityOrphanRow,
  right: CanonicalEntityOrphanRow
): number {
  const leftSeen =
    typeof left.evidence_summary.last_seen_at === 'number' ? left.evidence_summary.last_seen_at : 0;
  const rightSeen =
    typeof right.evidence_summary.last_seen_at === 'number'
      ? right.evidence_summary.last_seen_at
      : 0;
  if (rightSeen !== leftSeen) {
    return rightSeen - leftSeen;
  }
  return left.entity_id.localeCompare(right.entity_id);
}

export function listCanonicalEntityOrphans(
  adapter: ReadAdapter = getAdapter() as never,
  options: { min_age_ms?: number | null } = {}
): CanonicalEntityOrphanRow[] {
  const minAgeMs =
    typeof options.min_age_ms === 'number' && Number.isFinite(options.min_age_ms)
      ? Math.max(0, options.min_age_ms)
      : 0;
  const minCreatedAt = Date.now() - minAgeMs;

  const rows = adapter
    .prepare(
      `
        SELECT
          n.id AS entity_id,
          n.kind AS kind,
          n.preferred_label AS title,
          n.scope_kind AS scope_kind,
          n.scope_id AS scope_id,
          n.created_at AS created_at,
          COUNT(DISTINCT l.entity_observation_id) AS lineage_rows,
          COUNT(
            DISTINCT CASE
              WHEN COALESCE(o.source_raw_record_id, '') <> '' THEN l.entity_observation_id
              ELSE NULL
            END
          ) AS raw_evidence_rows,
          MAX(COALESCE(o.timestamp_observed, o.created_at)) AS last_seen_at
        FROM entity_nodes n
        INNER JOIN entity_lineage_links l
          ON l.canonical_entity_id = n.id
         AND l.status = 'active'
        INNER JOIN entity_observations o
          ON o.id = l.entity_observation_id
        WHERE n.status = 'active'
          AND n.merged_into IS NULL
          AND n.created_at <= ?
        GROUP BY n.id, n.kind, n.preferred_label, n.scope_kind, n.scope_id, n.created_at
      `
    )
    .all(minCreatedAt) as Array<{
    entity_id: string;
    title: string;
    kind: EntityNode['kind'];
    scope_kind: EntityNode['scope_kind'];
    scope_id: string | null;
    created_at: number;
    lineage_rows: number;
    raw_evidence_rows: number;
    last_seen_at: number | null;
  }>;

  const orphanRows = rows.map(
    (row): CanonicalEntityOrphanRow => ({
      entity_id: row.entity_id,
      title: row.title,
      kind: row.kind,
      scope_kind: row.scope_kind,
      scope_id: row.scope_id,
      scope_label: buildScopeLabel(row.scope_kind, row.scope_id),
      created_at: Number(row.created_at),
      linked_decision_count: 0,
      evidence_summary: {
        lineage_rows: Number(row.lineage_rows ?? 0),
        raw_evidence_rows: Number(row.raw_evidence_rows ?? 0),
        last_seen_at:
          row.last_seen_at === null || row.last_seen_at === undefined
            ? null
            : Number(row.last_seen_at),
      },
    })
  );

  const linkedCounts = loadLinkedDecisionCounts(
    adapter as never,
    orphanRows.map((row) => row.entity_id)
  );

  return orphanRows
    .map((row) => ({
      ...row,
      linked_decision_count: linkedCounts.get(row.entity_id) ?? 0,
    }))
    .filter(
      (row) =>
        row.evidence_summary.lineage_rows > 0 &&
        row.linked_decision_count === 0 &&
        !isNoisyCanonicalEntity(row)
    )
    .sort(compareOrphanRows);
}
