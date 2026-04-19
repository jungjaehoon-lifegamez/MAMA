import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  createEntityNode,
  getEntityNode,
  upsertEntityObservation,
} from '../../src/entities/store.js';

describe('Story E1.18: Exact duplicate canonical merge backfill', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('exact-merge-backfill');
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
    scopeId = 'calendar'
  ): Promise<void> {
    await upsertEntityObservation({
      id,
      observation_type: 'channel',
      entity_kind_hint: 'project',
      surface_form: label,
      normalized_form: label.toLowerCase(),
      lang: 'en',
      script: 'Latn',
      context_summary: `${label} context`,
      related_surface_forms: [],
      timestamp_observed: 1710000000000,
      scope_kind: 'channel',
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
      scope_kind: 'channel',
      scope_id: scopeId,
      merged_into: null,
    });
  }

  it('merges exact duplicate canonical roots into the oldest target and adopts lineage', async () => {
    await seedObservationBackedEntity('obs_calendar_a', 'calendar');
    await seedObservationBackedEntity('obs_calendar_b', 'calendar');
    const { backfillEntityLineage } = await import('../../src/entities/lineage-backfill.js');
    await backfillEntityLineage();

    const { backfillExactDuplicateCanonicals } =
      await import('../../src/entities/exact-merge-backfill.js');
    const result = await backfillExactDuplicateCanonicals();

    expect(result.groups).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.skipped).toBe(0);
    expect(getEntityNode('obs_calendar_a')?.merged_into).toBeNull();
    expect(getEntityNode('obs_calendar_b')?.merged_into).toBe('obs_calendar_a');

    const lineageRows = getAdapter()
      .prepare(
        `
          SELECT canonical_entity_id, entity_observation_id, contribution_kind, status
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
          ORDER BY entity_observation_id ASC
        `
      )
      .all('obs_calendar_a') as Array<{
      canonical_entity_id: string;
      entity_observation_id: string;
      contribution_kind: string;
      status: string;
    }>;

    expect(lineageRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_observation_id: 'obs_calendar_a',
          contribution_kind: 'seed',
          status: 'active',
        }),
        expect.objectContaining({
          entity_observation_id: 'obs_calendar_b',
          contribution_kind: 'merge_adopt',
          status: 'active',
        }),
      ])
    );
  });

  it('is idempotent after the first exact duplicate merge pass', async () => {
    await seedObservationBackedEntity('obs_calendar_a', 'calendar');
    await seedObservationBackedEntity('obs_calendar_b', 'calendar');
    const { backfillEntityLineage } = await import('../../src/entities/lineage-backfill.js');
    await backfillEntityLineage();

    const { backfillExactDuplicateCanonicals } =
      await import('../../src/entities/exact-merge-backfill.js');
    await backfillExactDuplicateCanonicals();
    const second = await backfillExactDuplicateCanonicals();

    expect(second.groups).toBe(0);
    expect(second.merged).toBe(0);
  });

  it('reports incomplete rows when canonical nodes are missing a source observation', async () => {
    await createEntityNode({
      id: 'entity_without_observation',
      kind: 'project',
      preferred_label: 'calendar',
      status: 'active',
      scope_kind: 'channel',
      scope_id: 'calendar',
      merged_into: null,
    });

    const { backfillExactDuplicateCanonicals } =
      await import('../../src/entities/exact-merge-backfill.js');
    const result = await backfillExactDuplicateCanonicals({ dryRun: true });

    expect(result.incomplete).toBe(1);
    expect(result.groups).toBe(0);
    expect(result.merged).toBe(0);
  });

  it('merges exact duplicate legacy roots even when observations are missing', async () => {
    await createEntityNode({
      id: 'entity_prov_demo_a',
      kind: 'project',
      preferred_label: 'Provenance Demo',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-provenance-demo',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_prov_demo_b',
      kind: 'project',
      preferred_label: 'Provenance Demo',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-provenance-demo',
      merged_into: null,
    });

    const { backfillExactDuplicateCanonicals } =
      await import('../../src/entities/exact-merge-backfill.js');
    const result = await backfillExactDuplicateCanonicals();

    expect(result.groups).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.incomplete).toBe(0);
    expect(getEntityNode('entity_prov_demo_a')?.merged_into).toBeNull();
    expect(getEntityNode('entity_prov_demo_b')?.merged_into).toBe('entity_prov_demo_a');
  });
});
