import { getAdapter, initDB } from '../db-manager.js';
import { EntityMergeError, mergeEntityNodes } from './store.js';
import { adoptLineageAfterMergeSync } from './lineage-store.js';
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

function runAdapterTransaction<T>(
  adapter: { transaction: <U>(fn: () => U) => U | (() => U) },
  fn: () => T
): T {
  const result = adapter.transaction(fn);
  return typeof result === 'function' ? (result as () => T)() : result;
}

function requireTransactionAdapter(adapter: Pick<ReturnType<typeof getAdapter>, 'transaction'>): {
  transaction: <U>(fn: () => U) => U | (() => U);
} {
  if (!('transaction' in adapter) || typeof adapter.transaction !== 'function') {
    throw new Error('exact-merge-backfill requires adapter.transaction');
  }
  return adapter as { transaction: <U>(fn: () => U) => U | (() => U) };
}

function mergeAndAdoptLineage(input: {
  adapter: ReturnType<typeof getAdapter>;
  source: ExactDuplicateRow;
  target: ExactDuplicateRow;
  groupKey: string;
}): void {
  const mergeResult = mergeEntityNodes({
    adapter: input.adapter,
    source_id: input.source.id,
    target_id: input.target.id,
    actor_type: 'system',
    actor_id: 'exact-duplicate-backfill',
    reason: 'Exact duplicate canonical backfill',
    candidate_id: null,
    evidence_json: JSON.stringify({
      strategy: 'exact_duplicate_backfill',
      group_key: input.groupKey,
      normalized_form: input.source.normalized_form,
      target_id: input.target.id,
    }),
  });
  adoptLineageAfterMergeSync({
    adapter: input.adapter,
    source_entity_id: input.source.id,
    target_entity_id: input.target.id,
    candidate_id: null,
    review_action_id: mergeResult.merge_action_id,
  });
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
        SELECT
          n.id,
          n.kind,
          n.preferred_label,
          n.scope_kind,
          n.scope_id,
          n.created_at,
          MIN(o.normalized_form) AS normalized_form
        FROM entity_nodes n
        LEFT JOIN entity_lineage_links l
          ON l.canonical_entity_id = n.id
         AND l.status = 'active'
        LEFT JOIN entity_observations o
          ON o.id = l.entity_observation_id
        WHERE n.status = 'active'
          AND n.merged_into IS NULL
        GROUP BY n.id, n.kind, n.preferred_label, n.scope_kind, n.scope_id, n.created_at
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
      const transactionalAdapter = requireTransactionAdapter(adapter);
      runAdapterTransaction(transactionalAdapter, () => {
        for (const source of sources) {
          mergeAndAdoptLineage({
            adapter,
            source,
            target,
            groupKey,
          });
        }
      });
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
