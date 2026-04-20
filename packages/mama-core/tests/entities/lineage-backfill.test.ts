import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  createEntityNode,
  mergeEntityNodes,
  upsertEntityObservation,
} from '../../src/entities/store.js';

describe('Story E1.13: Entity lineage backfill', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-lineage-backfill');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_ingest_runs').run();
    adapter.prepare('DELETE FROM entity_merge_actions').run();
    adapter.prepare('DELETE FROM entity_resolution_candidates').run();
    adapter.prepare('DELETE FROM entity_timeline_events').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
  });

  async function seedObservationBackedEntity(
    id: string,
    label: string,
    scopeId = 'scope-backfill'
  ) {
    await upsertEntityObservation({
      id,
      observation_type: 'generic',
      entity_kind_hint: 'project',
      surface_form: label,
      normalized_form: label.toLowerCase(),
      lang: 'en',
      script: 'Latn',
      context_summary: `${label} context`,
      related_surface_forms: [label],
      timestamp_observed: 1710000000000,
      scope_kind: 'project',
      scope_id: scopeId,
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '/tmp/slack/raw.db',
      source_raw_record_id: `raw_${id}`,
    });
    await createEntityNode({
      id,
      kind: 'project',
      preferred_label: label,
      status: 'active',
      scope_kind: 'project',
      scope_id: scopeId,
      merged_into: null,
    });
  }

  it('backfills seed lineage for existing active observation-backed entities', async () => {
    await seedObservationBackedEntity('obs_seed_backfill', 'Seed Backfill');

    const { backfillEntityLineage } = await import('../../src/entities/lineage-backfill.js');
    const result = await backfillEntityLineage();

    const rows = getAdapter()
      .prepare(
        `
          SELECT contribution_kind, capture_mode, status
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
        `
      )
      .all('obs_seed_backfill') as Array<{
      contribution_kind: string;
      capture_mode: string;
      status: string;
    }>;

    expect(result.seeded).toBe(1);
    expect(rows).toEqual([
      {
        contribution_kind: 'seed',
        capture_mode: 'backfilled',
        status: 'active',
      },
    ]);
  });

  it('backfills merge_adopt lineage from existing merge history', async () => {
    await seedObservationBackedEntity('obs_merge_source', 'Merge Source');
    await seedObservationBackedEntity('obs_merge_target', 'Merge Target');

    const adapter = getAdapter();
    const candidateId = 'cand_merge_backfill';
    adapter
      .prepare(
        `
          INSERT INTO entity_resolution_candidates (
            id, candidate_kind, left_ref, right_ref, status, score_total,
            score_structural, score_string, score_context, score_graph, score_embedding,
            rule_trace, extractor_version, embedding_model_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        candidateId,
        'entity_to_entity',
        'obs_merge_source',
        'obs_merge_target',
        'approved',
        0.95,
        1,
        0.5,
        0.25,
        0,
        0,
        '[]',
        'history-extractor@v1',
        'multilingual-e5-large',
        Date.now(),
        Date.now()
      );

    mergeEntityNodes({
      adapter,
      source_id: 'obs_merge_source',
      target_id: 'obs_merge_target',
      actor_type: 'user',
      actor_id: 'tester',
      reason: 'same entity',
      candidate_id: candidateId,
      evidence_json: '{}',
    });

    const { backfillEntityLineage } = await import('../../src/entities/lineage-backfill.js');
    const result = await backfillEntityLineage();

    const rows = adapter
      .prepare(
        `
          SELECT entity_observation_id, contribution_kind, canonical_entity_id, source_entity_id
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
          ORDER BY entity_observation_id ASC
        `
      )
      .all('obs_merge_target') as Array<{
      entity_observation_id: string;
      contribution_kind: string;
      canonical_entity_id: string;
      source_entity_id: string | null;
    }>;

    expect(result.adopted).toBe(1);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          entity_observation_id: 'obs_merge_source',
          contribution_kind: 'merge_adopt',
          canonical_entity_id: 'obs_merge_target',
          source_entity_id: 'obs_merge_source',
        },
        {
          entity_observation_id: 'obs_merge_target',
          contribution_kind: 'seed',
          canonical_entity_id: 'obs_merge_target',
          source_entity_id: null,
        },
      ])
    );
  });

  it('marks uncertain rows as capture_mode=backfilled with reduced confidence', async () => {
    await seedObservationBackedEntity('obs_confidence_backfill', 'Confidence Backfill');

    const { backfillEntityLineage } = await import('../../src/entities/lineage-backfill.js');
    await backfillEntityLineage();

    const row = getAdapter()
      .prepare(
        `
          SELECT capture_mode, confidence
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
        `
      )
      .get('obs_confidence_backfill') as { capture_mode: string; confidence: number } | undefined;

    expect(row?.capture_mode).toBe('backfilled');
    expect(row?.confidence).toBeLessThan(1);
  });

  it('never fabricates lineage when history is incomplete', async () => {
    await createEntityNode({
      id: 'entity_history_incomplete',
      kind: 'project',
      preferred_label: 'Incomplete',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-incomplete',
      merged_into: null,
    });

    const { backfillEntityLineage } = await import('../../src/entities/lineage-backfill.js');
    const result = await backfillEntityLineage();

    const rows = getAdapter()
      .prepare(`SELECT COUNT(*) AS total FROM entity_lineage_links WHERE canonical_entity_id = ?`)
      .get('entity_history_incomplete') as { total: number };

    expect(result.incomplete).toBe(1);
    expect(rows.total).toBe(0);
  });
});
