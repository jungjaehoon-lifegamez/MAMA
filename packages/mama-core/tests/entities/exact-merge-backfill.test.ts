import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { appendEntityLineageLink } from '../../src/entities/lineage-store.js';
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
    scopeId = 'calendar',
    observationLabel = label
  ): Promise<void> {
    await upsertEntityObservation({
      id: `obs_${id}`,
      observation_type: 'channel',
      entity_kind_hint: 'project',
      surface_form: observationLabel,
      normalized_form: observationLabel.toLowerCase(),
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
    await appendEntityLineageLink({
      canonical_entity_id: id,
      entity_observation_id: `obs_${id}`,
      source_entity_id: null,
      contribution_kind: 'seed',
      run_id: null,
      candidate_id: null,
      review_action_id: null,
      capture_mode: 'direct',
      confidence: 1,
    });
  }

  it('merges exact duplicate canonical roots into the oldest target and adopts lineage', async () => {
    await seedObservationBackedEntity(
      'entity_calendar_a',
      'Calendar Alpha',
      'calendar',
      'calendar'
    );
    await seedObservationBackedEntity('entity_calendar_b', 'Calendar Beta', 'calendar', 'calendar');

    const { backfillExactDuplicateCanonicals } =
      await import('../../src/entities/exact-merge-backfill.js');
    const result = await backfillExactDuplicateCanonicals();

    expect(result.groups).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.skipped).toBe(0);
    expect(getEntityNode('entity_calendar_a')?.merged_into).toBeNull();
    expect(getEntityNode('entity_calendar_b')?.merged_into).toBe('entity_calendar_a');

    const lineageRows = getAdapter()
      .prepare(
        `
          SELECT canonical_entity_id, entity_observation_id, contribution_kind, status
          FROM entity_lineage_links
          WHERE canonical_entity_id = ?
          ORDER BY entity_observation_id ASC
        `
      )
      .all('entity_calendar_a') as Array<{
      canonical_entity_id: string;
      entity_observation_id: string;
      contribution_kind: string;
      status: string;
    }>;

    expect(lineageRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_observation_id: 'obs_entity_calendar_a',
          contribution_kind: 'seed',
          status: 'active',
        }),
        expect.objectContaining({
          entity_observation_id: 'obs_entity_calendar_b',
          contribution_kind: 'merge_adopt',
          status: 'active',
        }),
      ])
    );
  });

  it('is idempotent after the first exact duplicate merge pass', async () => {
    await seedObservationBackedEntity(
      'entity_calendar_a',
      'Calendar Alpha',
      'calendar',
      'calendar'
    );
    await seedObservationBackedEntity('entity_calendar_b', 'Calendar Beta', 'calendar', 'calendar');

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

  it('requires adapter.transaction instead of using a non-transactional fallback', async () => {
    vi.resetModules();
    const mergeEntityNodes = vi.fn();
    const adoptLineageAfterMergeSync = vi.fn();
    const fakeAdapter = {
      prepare(sql: string) {
        if (sql.includes('FROM entity_nodes n')) {
          return {
            all: () =>
              [
                {
                  id: 'entity_a',
                  kind: 'project',
                  preferred_label: 'Calendar',
                  scope_kind: 'channel',
                  scope_id: 'calendar',
                  created_at: 1,
                  normalized_form: 'calendar',
                },
                {
                  id: 'entity_b',
                  kind: 'project',
                  preferred_label: 'Calendar',
                  scope_kind: 'channel',
                  scope_id: 'calendar',
                  created_at: 2,
                  normalized_form: 'calendar',
                },
              ] satisfies Array<{
                id: string;
                kind: 'project';
                preferred_label: string;
                scope_kind: 'channel';
                scope_id: string;
                created_at: number;
                normalized_form: string;
              }>,
          };
        }
        throw new Error(`Unexpected SQL in test adapter: ${sql}`);
      },
    };

    try {
      vi.doMock('../../src/db-manager.js', () => ({
        initDB: async () => {},
        getAdapter: () => fakeAdapter,
      }));
      vi.doMock('../../src/entities/store.js', () => ({
        EntityMergeError: class EntityMergeError extends Error {},
        mergeEntityNodes,
      }));
      vi.doMock('../../src/entities/lineage-store.js', () => ({
        adoptLineageAfterMergeSync,
      }));

      const { backfillExactDuplicateCanonicals } =
        await import('../../src/entities/exact-merge-backfill.js');

      await expect(backfillExactDuplicateCanonicals()).rejects.toThrow(
        'exact-merge-backfill requires adapter.transaction'
      );
      expect(mergeEntityNodes).not.toHaveBeenCalled();
      expect(adoptLineageAfterMergeSync).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../src/db-manager.js');
      vi.doUnmock('../../src/entities/store.js');
      vi.doUnmock('../../src/entities/lineage-store.js');
      vi.resetModules();
    }
  });
});
