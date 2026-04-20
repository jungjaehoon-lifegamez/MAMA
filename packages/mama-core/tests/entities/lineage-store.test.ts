import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('Story E1.12: Entity lineage substrate', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-lineage-store');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: migration creates lineage tables', () => {
    it('creates entity_ingest_runs and entity_lineage_links tables', () => {
      const adapter = getAdapter();
      const tables = adapter
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name IN ('entity_ingest_runs', 'entity_lineage_links')
            ORDER BY name
          `
        )
        .all() as Array<{ name: string }>;

      expect(tables.map((row) => row.name)).toEqual(['entity_ingest_runs', 'entity_lineage_links']);
    });

    it('creates the active-lineage uniqueness constraint', () => {
      const adapter = getAdapter();
      const indexes = adapter
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND tbl_name = 'entity_lineage_links'
            ORDER BY name
          `
        )
        .all() as Array<{ name: string }>;

      expect(indexes.map((row) => row.name)).toContain('ux_entity_lineage_active_pair');
    });
  });

  describe('AC #2: lineage store helpers manage append-only state', () => {
    it('creates entity_ingest_runs rows and updates completion fields', async () => {
      const { completeEntityIngestRun, createEntityIngestRun } =
        await import('../../src/entities/lineage-store.js');

      const created = await createEntityIngestRun({
        id: 'eir_test_1',
        connector: 'slack',
        run_kind: 'replay',
        scope_key: 'slack:C123',
        source_window_start: 1710000000000,
        source_window_end: 1710003600000,
      });

      await completeEntityIngestRun(created.id, {
        raw_count: 3,
        observation_count: 6,
        candidate_count: 2,
        reviewable_count: 1,
        audit_classification: 'stable',
      });

      const row = getAdapter()
        .prepare(`SELECT * FROM entity_ingest_runs WHERE id = ?`)
        .get(created.id) as
        | {
            status: string;
            raw_count: number;
            observation_count: number;
            candidate_count: number;
            reviewable_count: number;
            audit_classification: string;
            completed_at: number | null;
          }
        | undefined;

      expect(row?.status).toBe('complete');
      expect(row?.raw_count).toBe(3);
      expect(row?.observation_count).toBe(6);
      expect(row?.candidate_count).toBe(2);
      expect(row?.reviewable_count).toBe(1);
      expect(row?.audit_classification).toBe('stable');
      expect(row?.completed_at).toBeTypeOf('number');
    });

    it('throws a clear error when completing or failing an unknown ingest run id', async () => {
      const { completeEntityIngestRun, failEntityIngestRun } =
        await import('../../src/entities/lineage-store.js');

      await expect(
        completeEntityIngestRun('eir_missing_complete', {
          raw_count: 1,
          observation_count: 1,
          candidate_count: 0,
          reviewable_count: 0,
        })
      ).rejects.toThrow(/Entity ingest run not found: eir_missing_complete/);

      await expect(failEntityIngestRun('eir_missing_fail', 'boom')).rejects.toThrow(
        /Entity ingest run not found: eir_missing_fail/
      );
    });

    it('appends active seed lineage rows idempotently', async () => {
      const { appendEntityLineageLink } = await import('../../src/entities/lineage-store.js');
      const adapter = getAdapter();

      adapter
        .prepare(
          `
            INSERT INTO entity_nodes (
              id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'entity_project_seed',
          'project',
          'Project Seed',
          'active',
          'project',
          'scope-seed',
          null,
          1710000000000,
          1710000000000
        );

      adapter
        .prepare(
          `
            INSERT INTO entity_observations (
              id, observation_type, entity_kind_hint, surface_form, normalized_form,
              lang, script, context_summary, related_surface_forms, timestamp_observed,
              scope_kind, scope_id, extractor_version, embedding_model_version,
              source_connector, source_locator, source_raw_record_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'obs_project_seed',
          'generic',
          'project',
          'Project Seed',
          'project seed',
          'en',
          'Latn',
          'seed observation',
          '[]',
          1710000000000,
          'project',
          'scope-seed',
          'history-extractor@v1',
          'multilingual-e5-large',
          'slack',
          '/tmp/slack/raw.db',
          'raw_seed_1',
          1710000000000
        );

      const first = await appendEntityLineageLink({
        canonical_entity_id: 'entity_project_seed',
        entity_observation_id: 'obs_project_seed',
        source_entity_id: null,
        contribution_kind: 'seed',
        run_id: null,
        candidate_id: null,
        review_action_id: null,
        capture_mode: 'direct',
        confidence: 1,
      });

      const second = await appendEntityLineageLink({
        canonical_entity_id: 'entity_project_seed',
        entity_observation_id: 'obs_project_seed',
        source_entity_id: null,
        contribution_kind: 'seed',
        run_id: null,
        candidate_id: null,
        review_action_id: null,
        capture_mode: 'direct',
        confidence: 1,
      });

      const rows = adapter
        .prepare(
          `
            SELECT id
            FROM entity_lineage_links
            WHERE canonical_entity_id = ?
              AND entity_observation_id = ?
              AND status = 'active'
          `
        )
        .all('entity_project_seed', 'obs_project_seed') as Array<{ id: string }>;

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.link.id).toBe(first.link.id);
      expect(rows).toHaveLength(1);
    });

    it('supersedes lineage rows instead of deleting them', async () => {
      const { appendEntityLineageLink, supersedeEntityLineageForEntity } =
        await import('../../src/entities/lineage-store.js');
      const adapter = getAdapter();

      adapter
        .prepare(
          `
            INSERT INTO entity_nodes (
              id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'entity_project_supersede',
          'project',
          'Project Supersede',
          'active',
          'project',
          'scope-supersede',
          null,
          1710000000000,
          1710000000000
        );

      adapter
        .prepare(
          `
            INSERT INTO entity_observations (
              id, observation_type, entity_kind_hint, surface_form, normalized_form,
              lang, script, context_summary, related_surface_forms, timestamp_observed,
              scope_kind, scope_id, extractor_version, embedding_model_version,
              source_connector, source_locator, source_raw_record_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'obs_project_supersede',
          'generic',
          'project',
          'Project Supersede',
          'project supersede',
          'en',
          'Latn',
          'supersede observation',
          '[]',
          1710000000000,
          'project',
          'scope-supersede',
          'history-extractor@v1',
          'multilingual-e5-large',
          'slack',
          '/tmp/slack/raw.db',
          'raw_supersede_1',
          1710000000000
        );

      const created = await appendEntityLineageLink({
        canonical_entity_id: 'entity_project_supersede',
        entity_observation_id: 'obs_project_supersede',
        source_entity_id: null,
        contribution_kind: 'seed',
        run_id: null,
        candidate_id: null,
        review_action_id: null,
        capture_mode: 'direct',
        confidence: 1,
      });

      await supersedeEntityLineageForEntity('entity_project_supersede');

      const row = adapter
        .prepare(`SELECT status, superseded_at FROM entity_lineage_links WHERE id = ?`)
        .get(created.link.id) as { status: string; superseded_at: number | null } | undefined;

      expect(row?.status).toBe('superseded');
      expect(row?.superseded_at).toBeTypeOf('number');
    });

    it('returns only active lineage rows for an entity detail view', async () => {
      const { listActiveEntityLineage } = await import('../../src/entities/lineage-store.js');

      const rows = await listActiveEntityLineage('entity_project_seed');

      expect(rows.every((row) => row.status === 'active')).toBe(true);
      expect(rows.map((row) => row.entity_observation_id)).toContain('obs_project_seed');
    });
  });
});
