import { getAdapter, initDB } from '../db-manager.js';
import { loadLinkedDecisionCounts } from './entity-linked-decision-counts.js';
import type { EntityNode } from './types.js';

export interface ListCanonicalEntitiesInput {
  limit: number;
  cursor?: string | null;
  include_noisy?: boolean;
}

export interface CanonicalEntityListRow {
  id: string;
  kind: EntityNode['kind'];
  preferred_label: string;
  scope_kind: EntityNode['scope_kind'];
  scope_id: string | null;
  created_at: number;
  linked_decision_count: number;
}

type CanonicalEntityListBaseRow = Omit<CanonicalEntityListRow, 'linked_decision_count'>;

export interface ListCanonicalEntitiesResult {
  entities: CanonicalEntityListRow[];
  next_cursor: string | null;
  total_count: number;
  visible_count: number;
}

function normalizeBrowseLabel(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function buildBrowseCollapseKey(row: CanonicalEntityListBaseRow): string {
  return JSON.stringify([
    row.kind,
    row.scope_kind,
    row.scope_id ?? '',
    normalizeBrowseLabel(row.preferred_label),
  ]);
}

function compareCanonicalRows(
  left: CanonicalEntityListBaseRow,
  right: CanonicalEntityListBaseRow
): number {
  if (right.created_at !== left.created_at) {
    return right.created_at - left.created_at;
  }
  const labelCompare = left.preferred_label.localeCompare(right.preferred_label);
  if (labelCompare !== 0) {
    return labelCompare;
  }
  return left.id.localeCompare(right.id);
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

function isNoisyCanonicalEntity(row: CanonicalEntityListBaseRow): boolean {
  const label = row.preferred_label.trim().toLowerCase();
  if (row.kind === 'person') {
    return label === 'user' || label === 'claude';
  }
  if (row.kind === 'project') {
    return label === 'workspace';
  }
  return false;
}

export async function listCanonicalEntities(
  input: ListCanonicalEntitiesInput
): Promise<ListCanonicalEntitiesResult> {
  await initDB();
  const adapter = getAdapter();
  const rows = adapter
    .prepare(
      `
        SELECT id, kind, preferred_label, scope_kind, scope_id, created_at
        FROM entity_nodes
        WHERE status = 'active'
          AND merged_into IS NULL
      `
    )
    .all() as CanonicalEntityListBaseRow[];

  const sorted = rows.sort(compareCanonicalRows);
  const collapsedByKey = new Map<string, CanonicalEntityListBaseRow>();
  for (const row of sorted) {
    const key = buildBrowseCollapseKey(row);
    const existing = collapsedByKey.get(key);
    if (!existing) {
      collapsedByKey.set(key, row);
      continue;
    }
    if (
      row.created_at > existing.created_at ||
      (row.created_at === existing.created_at && row.id.localeCompare(existing.id) < 0)
    ) {
      collapsedByKey.set(key, row);
    }
  }
  const collapsed = Array.from(collapsedByKey.values()).sort(compareCanonicalRows);

  const totalCount = sorted.length;
  const visibleBase =
    input.include_noisy === false
      ? collapsed.filter((row) => !isNoisyCanonicalEntity(row))
      : collapsed;
  const linkedCounts = loadLinkedDecisionCounts(
    adapter,
    visibleBase.map((row) => row.id)
  );
  const visible = visibleBase.map((row) => ({
    ...row,
    linked_decision_count: linkedCounts.get(row.id) ?? 0,
  }));
  const visibleCount = visible.length;
  const offset = decodeCursor(input.cursor);
  const limit = Math.max(1, input.limit);
  const entities = visible.slice(offset, offset + limit);
  const nextCursor = offset + limit < visible.length ? encodeCursor(offset + limit) : null;

  return {
    entities,
    next_cursor: nextCursor,
    total_count: totalCount,
    visible_count: visibleCount,
  };
}
