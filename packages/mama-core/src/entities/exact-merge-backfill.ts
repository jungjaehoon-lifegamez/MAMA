import { getAdapter, initDB } from '../db-manager.js';
import { EntityMergeError, mergeEntityNodes } from './store.js';
import { adoptLineageAfterMerge } from './lineage-store.js';
import type { EntityNode } from './types.js';

export interface ExactMergeBackfillOptions {
  dryRun?: boolean;
}

export interface ExactMergeBackfillResult {
  groups: number;
  merged: number;
  incomplete: number;
  skipped: number;
}

interface ExactDuplicateRow {
  id: string;
  kind: EntityNode['kind'];
  preferred_label: string;
  scope_kind: EntityNode['scope_kind'];
  scope_id: string | null;
  created_at: number;
  normalized_form: string | null;
}

function normalizeExactLabel(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function buildExactGroupKey(
  row: ExactDuplicateRow
): { key: string; fromObservation: boolean } | null {
  if (row.normalized_form) {
    return {
      key: JSON.stringify([row.kind, row.scope_kind, row.scope_id ?? '', row.normalized_form]),
      fromObservation: true,
    };
  }
  const fallback = normalizeExactLabel(row.preferred_label);
  if (!fallback) {
    return null;
  }
  return {
    key: JSON.stringify([row.kind, row.scope_kind, row.scope_id ?? '', fallback]),
    fromObservation: false,
  };
}

function compareRows(left: ExactDuplicateRow, right: ExactDuplicateRow): number {
  if (left.created_at !== right.created_at) {
    return left.created_at - right.created_at;
  }
  return left.id.localeCompare(right.id);
}

export async function backfillExactDuplicateCanonicals(
  opts: ExactMergeBackfillOptions = {}
): Promise<ExactMergeBackfillResult> {
  await initDB();
  const adapter = getAdapter();
  const dryRun = opts.dryRun === true;
  let groups = 0;
  let merged = 0;
  let incomplete = 0;
  let skipped = 0;

  const rows = adapter
    .prepare(
      `
        SELECT n.id, n.kind, n.preferred_label, n.scope_kind, n.scope_id, n.created_at, o.normalized_form
        FROM entity_nodes n
        LEFT JOIN entity_observations o ON o.id = n.id
        WHERE n.status = 'active'
          AND n.merged_into IS NULL
      `
    )
    .all() as ExactDuplicateRow[];

  const grouped = new Map<string, ExactDuplicateRow[]>();
  const fallbackRows = new Set<string>();
  for (const row of rows) {
    const keyInfo = buildExactGroupKey(row);
    if (!keyInfo) {
      incomplete += 1;
      continue;
    }
    if (!keyInfo.fromObservation) {
      fallbackRows.add(row.id);
    }
    const bucket = grouped.get(keyInfo.key) ?? [];
    bucket.push(row);
    grouped.set(keyInfo.key, bucket);
  }

  for (const bucket of grouped.values()) {
    if (bucket.length >= 2) {
      continue;
    }
    for (const row of bucket) {
      if (fallbackRows.has(row.id)) {
        incomplete += 1;
      }
    }
  }

  for (const [groupKey, bucket] of grouped.entries()) {
    if (bucket.length < 2) {
      continue;
    }

    groups += 1;
    const sorted = [...bucket].sort(compareRows);
    const target = sorted[0]!;
    const sources = sorted.slice(1);

    if (dryRun) {
      merged += sources.length;
      continue;
    }

    try {
      if ('transaction' in adapter && typeof adapter.transaction === 'function') {
        adapter.transaction(() => {
          for (const source of sources) {
            const mergeResult = mergeEntityNodes({
              adapter,
              source_id: source.id,
              target_id: target.id,
              actor_type: 'system',
              actor_id: 'exact-duplicate-backfill',
              reason: 'Exact duplicate canonical backfill',
              candidate_id: null,
              evidence_json: JSON.stringify({
                strategy: 'exact_duplicate_backfill',
                group_key: groupKey,
                normalized_form: source.normalized_form,
                target_id: target.id,
              }),
            });
            adoptLineageAfterMerge({
              adapter,
              source_entity_id: source.id,
              target_entity_id: target.id,
              candidate_id: null,
              review_action_id: mergeResult.merge_action_id,
            });
          }
        });
      } else {
        for (const source of sources) {
          const mergeResult = mergeEntityNodes({
            adapter,
            source_id: source.id,
            target_id: target.id,
            actor_type: 'system',
            actor_id: 'exact-duplicate-backfill',
            reason: 'Exact duplicate canonical backfill',
            candidate_id: null,
            evidence_json: JSON.stringify({
              strategy: 'exact_duplicate_backfill',
              group_key: groupKey,
              normalized_form: source.normalized_form,
              target_id: target.id,
            }),
          });
          adoptLineageAfterMerge({
            adapter,
            source_entity_id: source.id,
            target_entity_id: target.id,
            candidate_id: null,
            review_action_id: mergeResult.merge_action_id,
          });
        }
      }
      merged += sources.length;
    } catch (error) {
      if (error instanceof EntityMergeError) {
        skipped += sources.length;
        continue;
      }
      throw error;
    }
  }

  return {
    groups,
    merged,
    incomplete,
    skipped,
  };
}
