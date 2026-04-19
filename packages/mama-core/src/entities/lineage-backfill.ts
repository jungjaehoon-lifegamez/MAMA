import { getAdapter, initDB } from '../db-manager.js';
import { appendEntityLineageLink } from './lineage-store.js';

interface BackfillEntityLineageOptions {
  dryRun?: boolean;
  now?: number;
}

interface BackfillEntityLineageResult {
  seeded: number;
  adopted: number;
  incomplete: number;
}

export async function backfillEntityLineage(
  opts: BackfillEntityLineageOptions = {}
): Promise<BackfillEntityLineageResult> {
  await initDB();
  const adapter = getAdapter();
  const dryRun = opts.dryRun === true;
  const seedConfidence = 0.75;
  const adoptConfidence = 0.6;

  let seeded = 0;
  let adopted = 0;
  let incomplete = 0;

  const activeRows = adapter
    .prepare(
      `
        SELECT n.id, o.id AS observation_id
        FROM entity_nodes n
        LEFT JOIN entity_observations o ON o.id = n.id
        WHERE n.status = 'active'
          AND n.merged_into IS NULL
      `
    )
    .all() as Array<{ id: string; observation_id: string | null }>;

  for (const row of activeRows) {
    if (!row.observation_id) {
      incomplete += 1;
      continue;
    }
    const existing = adapter
      .prepare(
        `
          SELECT id
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
            AND entity_observation_id = ?
            AND status = 'active'
          LIMIT 1
        `
      )
      .get(row.id, row.observation_id) as { id: string } | undefined;
    if (existing) {
      continue;
    }
    seeded += 1;
    if (!dryRun) {
      await appendEntityLineageLink({
        canonical_entity_id: row.id,
        entity_observation_id: row.observation_id,
        source_entity_id: null,
        contribution_kind: 'seed',
        run_id: null,
        candidate_id: null,
        review_action_id: null,
        capture_mode: 'backfilled',
        confidence: seedConfidence,
      });
    }
  }

  const mergedRows = adapter
    .prepare(
      `
        SELECT n.id AS source_entity_id, n.merged_into AS target_entity_id, o.id AS observation_id
        FROM entity_nodes n
        LEFT JOIN entity_observations o ON o.id = n.id
        WHERE n.status = 'merged'
          AND n.merged_into IS NOT NULL
      `
    )
    .all() as Array<{
    source_entity_id: string;
    target_entity_id: string;
    observation_id: string | null;
  }>;

  for (const row of mergedRows) {
    if (!row.observation_id) {
      incomplete += 1;
      continue;
    }
    const existing = adapter
      .prepare(
        `
          SELECT id
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
            AND entity_observation_id = ?
            AND status = 'active'
          LIMIT 1
        `
      )
      .get(row.target_entity_id, row.observation_id) as { id: string } | undefined;
    if (existing) {
      continue;
    }
    adopted += 1;
    if (!dryRun) {
      await appendEntityLineageLink({
        canonical_entity_id: row.target_entity_id,
        entity_observation_id: row.observation_id,
        source_entity_id: row.source_entity_id,
        contribution_kind: 'merge_adopt',
        run_id: null,
        candidate_id: null,
        review_action_id: null,
        capture_mode: 'backfilled',
        confidence: adoptConfidence,
      });
    }
  }

  return { seeded, adopted, incomplete };
}
