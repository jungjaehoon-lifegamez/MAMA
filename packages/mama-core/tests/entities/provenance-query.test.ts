import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { saveMemory } from '../../src/memory/api.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('Story E1.10: Decision provenance query', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-provenance-query');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: migration creates decision_entity_sources', () => {
    it('creates the provenance link table and indexes', () => {
      const adapter = getAdapter();
      const tables = adapter
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'decision_entity_sources'
          `
        )
        .all() as Array<{ name: string }>;

      const indexes = adapter
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'decision_entity_sources'
            ORDER BY name
          `
        )
        .all() as Array<{ name: string }>;

      expect(tables.map((row) => row.name)).toEqual(['decision_entity_sources']);
      expect(indexes.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'idx_decision_entity_sources_decision',
          'idx_decision_entity_sources_observation',
          'ux_decision_entity_sources_unique',
        ])
      );
    });

    it('enforces uniqueness and cascades on delete', async () => {
      const adapter = getAdapter();
      const created = await saveMemory({
        topic: 'project_alpha/launch',
        kind: 'decision',
        summary: 'Project Alpha launch decision',
        details: 'Created only for provenance migration coverage.',
        confidence: 0.8,
        scopes: [{ kind: 'project', id: 'scope-alpha' }],
        source: { package: 'mama-core', source_type: 'test' },
      });

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
          'obs_project_alpha_launch',
          'generic',
          'project',
          'Project Alpha',
          'project alpha',
          'en',
          'Latn',
          'Launch decision mentioned in Slack',
          JSON.stringify(['Project Alpha KR']),
          1710000000000,
          'project',
          'scope-alpha',
          'history-extractor@v1',
          'multilingual-e5-large',
          'slack',
          '/tmp/slack/raw.db',
          'raw_slack_001',
          1710000000000
        );

      adapter
        .prepare(
          `
            INSERT INTO decision_entity_sources (
              decision_id, entity_observation_id, relation_type, created_at
            ) VALUES (?, ?, ?, ?)
          `
        )
        .run(created.id, 'obs_project_alpha_launch', 'support', 1710000001000);

      expect(() =>
        adapter
          .prepare(
            `
              INSERT INTO decision_entity_sources (
                decision_id, entity_observation_id, relation_type, created_at
              ) VALUES (?, ?, ?, ?)
            `
          )
          .run(created.id, 'obs_project_alpha_launch', 'support', 1710000001001)
      ).toThrow();

      adapter.prepare(`DELETE FROM decisions WHERE id = ?`).run(created.id);
      const remaining = adapter
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM decision_entity_sources
            WHERE entity_observation_id = ?
          `
        )
        .get('obs_project_alpha_launch') as { total: number };

      expect(remaining.total).toBe(0);
    });
  });

  describe('AC #2: provenance query resolves memory -> observation -> entity path', () => {
    it('attaches the created memory id when provenance link writes roll back', async () => {
      const adapter = getAdapter();
      let thrown: unknown;

      try {
        await saveMemory({
          topic: 'project_delta/failure',
          kind: 'decision',
          summary: 'Project Delta should surface the failed memory id',
          details: 'This save intentionally points at a missing observation id.',
          confidence: 0.5,
          scopes: [{ kind: 'project', id: 'scope-delta' }],
          source: { package: 'mama-core', source_type: 'test' },
          entityObservationIds: ['obs_missing_for_failure_path'],
        } as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const failedSave = thrown as Error & { memoryId?: string };
      expect(failedSave.message).toContain('FOREIGN KEY');
      expect(failedSave.memoryId).toBeTruthy();

      const failedRow = adapter
        .prepare(
          `
            SELECT id
            FROM decisions
            WHERE id = ?
          `
        )
        .get(failedSave.memoryId) as { id: string } | undefined;
      expect(failedRow).toBeUndefined();

      const linkedRows = adapter
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM decision_entity_sources
            WHERE decision_id = ?
          `
        )
        .get(failedSave.memoryId) as { total: number };
      expect(linkedRows.total).toBe(0);
    });
  });
});
