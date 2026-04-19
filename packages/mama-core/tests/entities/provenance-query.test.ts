import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { saveMemory } from '../../src/memory/api.js';
import { appendMemoryEvent } from '../../src/memory/event-store.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { queryProvenanceForMemory } from '../../src/entities/provenance-query.js';

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
    it('returns explicit legacy state when no provenance links exist', async () => {
      const created = await saveMemory({
        topic: 'project_beta/spec',
        kind: 'decision',
        summary: 'Legacy-style decision without entity provenance',
        details: 'No observation ids attached.',
        confidence: 0.6,
        scopes: [{ kind: 'project', id: 'scope-beta' }],
        source: { package: 'mama-core', source_type: 'test' },
      });

      const result = await queryProvenanceForMemory(created.id);

      expect(result.status).toBe('legacy');
      expect(result.memory.id).toBe(created.id);
      expect(result.observations).toEqual([]);
    });

    it('persists decision_entity_sources when saveMemory receives provenance refs', async () => {
      const adapter = getAdapter();
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
          'obs_project_gamma_launch',
          'generic',
          'project',
          'Project Gamma',
          'project gamma',
          'en',
          'Latn',
          'Launch decision in connector history',
          JSON.stringify(['Project Gamma KR']),
          1710000002000,
          'project',
          'scope-gamma',
          'history-extractor@v1',
          'multilingual-e5-large',
          'slack',
          '/tmp/slack/raw.db',
          'raw_slack_002',
          1710000002000
        );

      const created = await saveMemory({
        topic: 'project_gamma/launch',
        kind: 'decision',
        summary: 'Project Gamma launch approved',
        details: 'Persisted with entity provenance support.',
        confidence: 0.9,
        scopes: [{ kind: 'project', id: 'scope-gamma' }],
        source: { package: 'mama-core', source_type: 'test' },
        entityObservationIds: ['obs_project_gamma_launch', 'obs_project_gamma_launch'],
      } as never);

      const linked = adapter
        .prepare(
          `
            SELECT entity_observation_id, relation_type
            FROM decision_entity_sources
            WHERE decision_id = ?
            ORDER BY entity_observation_id ASC
          `
        )
        .all(created.id) as Array<{
        entity_observation_id: string;
        relation_type: string;
      }>;

      expect(linked).toEqual([
        {
          entity_observation_id: 'obs_project_gamma_launch',
          relation_type: 'support',
        },
      ]);

      const result = await queryProvenanceForMemory(created.id);
      expect(result.status).toBe('resolved');
      expect(result.observations.map((item) => item.id)).toEqual(['obs_project_gamma_launch']);
      expect(result.observations[0]).toEqual(
        expect.objectContaining({
          source_locator: '/tmp/slack/raw.db',
          source_locator_kind: 'db',
        })
      );
    });

    it('classifies URL locators through source_locator', async () => {
      const adapter = getAdapter();
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
          'obs_project_locator_url',
          'generic',
          'project',
          'Project Locator',
          'project locator',
          'en',
          'Latn',
          'URL-backed provenance',
          JSON.stringify(['Locator']),
          1710000002100,
          'project',
          'scope-gamma',
          'history-extractor@v1',
          'multilingual-e5-large',
          'drive',
          'https://drive.google.com/file/d/file-1/view',
          'raw_drive_001',
          1710000002100
        );

      const created = await saveMemory({
        topic: 'project_locator/url',
        kind: 'decision',
        summary: 'URL-backed provenance decision',
        details: 'Provenance uses a web locator.',
        confidence: 0.9,
        scopes: [{ kind: 'project', id: 'scope-gamma' }],
        source: { package: 'mama-core', source_type: 'test' },
        entityObservationIds: ['obs_project_locator_url'],
      } as never);

      const result = await queryProvenanceForMemory(created.id);
      expect(result.observations[0]).toEqual(
        expect.objectContaining({
          source_locator: 'https://drive.google.com/file/d/file-1/view',
          source_locator_kind: 'url',
        })
      );
    });

    it('returns manual when an empty-batch provenance audit event exists', async () => {
      const created = await saveMemory({
        topic: 'project_epsilon/manual',
        kind: 'decision',
        summary: 'Project Epsilon was saved from an empty provenance batch',
        details: 'No supporting observations were produced for this channel batch.',
        confidence: 0.55,
        scopes: [{ kind: 'project', id: 'scope-epsilon' }],
        source: { package: 'standalone', source_type: 'connector' },
      } as never);

      await appendMemoryEvent({
        event_type: 'provenance.empty_batch',
        actor: 'system',
        memory_id: created.id,
        topic: created.topic,
        scope_refs: [{ kind: 'project', id: 'scope-epsilon' }],
        reason: 'channel_key=slack:general',
        created_at: Date.now(),
      });

      const result = await queryProvenanceForMemory(created.id);

      expect(result.status).toBe('manual');
      expect(result.audit?.event_type).toBe('provenance.empty_batch');
    });

    it('returns dropped when provenance link writing failed after the decision row was created', async () => {
      const created = await saveMemory({
        topic: 'project_zeta/dropped',
        kind: 'decision',
        summary: 'Project Zeta dropped its provenance links after save',
        details: 'The decision row exists but provenance binding failed.',
        confidence: 0.5,
        scopes: [{ kind: 'project', id: 'scope-zeta' }],
        source: { package: 'standalone', source_type: 'connector' },
      } as never);

      await appendMemoryEvent({
        event_type: 'provenance.link_write_failed',
        actor: 'system',
        memory_id: created.id,
        topic: created.topic,
        scope_refs: [{ kind: 'project', id: 'scope-zeta' }],
        reason: 'FOREIGN KEY constraint failed; dropped_observation_count=1',
        created_at: Date.now(),
      });

      const result = await queryProvenanceForMemory(created.id);

      expect(result.status).toBe('dropped');
      expect(result.audit?.event_type).toBe('provenance.link_write_failed');
      expect(result.audit?.reason).toContain('dropped_observation_count=1');
    });

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
