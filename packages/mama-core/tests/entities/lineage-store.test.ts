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

    it('returns only active lineage rows for an entity detail view', async () => {
      const { listActiveEntityLineage } = await import('../../src/entities/lineage-store.js');

      const rows = await listActiveEntityLineage('entity_project_seed');

      expect(rows.every((row) => row.status === 'active')).toBe(true);
      expect(rows.map((row) => row.entity_observation_id)).toContain('obs_project_seed');
    });
  });
});
