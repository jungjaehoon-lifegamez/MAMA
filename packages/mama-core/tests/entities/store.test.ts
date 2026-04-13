import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachEntityAlias,
  createEntityNode,
  getEntityNode,
  listEntityAliases,
  listEntityNodes,
  parseObservationRow,
  upsertEntityObservation,
} from '../../src/entities/store.js';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('Story E1.3: Canonical entity persistence', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-store');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: migrations create the required entity tables', () => {
    it('should create the canonical entity tables', () => {
      const adapter = getAdapter();
      const tables = adapter
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `
        )
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((row) => row.name);

      expect(tableNames).toContain('entity_nodes');
      expect(tableNames).toContain('entity_aliases');
      expect(tableNames).toContain('entity_observations');
      expect(tableNames).toContain('entity_resolution_candidates');
      expect(tableNames).toContain('entity_links');
      expect(tableNames).toContain('entity_timeline_events');
      expect(tableNames).toContain('entity_merge_actions');
    });
  });

  describe('AC #2: entity schema preserves scope and provenance columns', () => {
    it('should create scope columns on entity_nodes', () => {
      const adapter = getAdapter();
      const columns = adapter.prepare('PRAGMA table_info(entity_nodes)').all() as Array<{
        name: string;
      }>;
      const names = columns.map((column) => column.name);

      expect(names).toContain('scope_kind');
      expect(names).toContain('scope_id');
    });

    it('should create raw provenance columns on entity_observations', () => {
      const adapter = getAdapter();
      const columns = adapter.prepare('PRAGMA table_info(entity_observations)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const names = columns.map((column) => column.name);

      expect(names).toContain('scope_kind');
      expect(names).toContain('scope_id');
      expect(names).toContain('observation_type');
      expect(names).toContain('extractor_version');
      expect(names).toContain('embedding_model_version');
      expect(names).toContain('source_connector');
      expect(names).toContain('source_raw_db_ref');
      expect(names).toContain('source_raw_record_id');
      expect(columns.find((column) => column.name === 'source_connector')?.notnull).toBe(1);
    });

    it('should create version columns on entity_resolution_candidates', () => {
      const adapter = getAdapter();
      const columns = adapter
        .prepare('PRAGMA table_info(entity_resolution_candidates)')
        .all() as Array<{
        name: string;
      }>;
      const names = columns.map((column) => column.name);

      expect(names).toContain('extractor_version');
      expect(names).toContain('embedding_model_version');
    });
  });

  describe('AC #3: performance-critical indexes are created', () => {
    it('should create the candidate status score index', () => {
      const adapter = getAdapter();
      const indexes = adapter
        .prepare("PRAGMA index_list('entity_resolution_candidates')")
        .all() as Array<{
        name: string;
      }>;
      const names = indexes.map((index) => index.name);

      expect(names).toContain('idx_entity_candidates_status_score');
    });

    it('should create the raw provenance index on entity_observations', () => {
      const adapter = getAdapter();
      const indexes = adapter.prepare("PRAGMA index_list('entity_observations')").all() as Array<{
        name: string;
      }>;
      const names = indexes.map((index) => index.name);

      expect(names).toContain('idx_entity_observations_source_record');
    });
  });

  describe('AC #4: store helpers provide basic CRUD for the first entity tables', () => {
    it('should create and read back an entity node', async () => {
      const created = await createEntityNode({
        id: 'entity_project_alpha',
        kind: 'project',
        preferred_label: 'Project Alpha',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'scope-project-alpha',
        merged_into: null,
      });

      const loaded = getEntityNode(created.id);

      expect(loaded?.preferred_label).toBe('Project Alpha');
      expect(listEntityNodes()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'entity_project_alpha' })])
      );
    });

    it('should attach aliases and list them for the entity', async () => {
      await attachEntityAlias({
        id: 'alias_project_alpha_ko',
        entity_id: 'entity_project_alpha',
        label: 'プロジェクトアルファ',
        normalized_label: 'project-alpha-ja',
        lang: 'ja',
        script: 'Jpan',
        label_type: 'alt',
        source_type: 'slack',
        source_ref: 'slack:C123:1710000000.000100',
        confidence: 0.9,
        status: 'active',
      });

      expect(listEntityAliases('entity_project_alpha')).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'プロジェクトアルファ' })])
      );
    });

    it('should upsert observations keyed by source record identity', async () => {
      const first = await upsertEntityObservation({
        id: 'obs_project_alpha_1',
        observation_type: 'generic',
        entity_kind_hint: 'project',
        surface_form: 'Project Alpha',
        normalized_form: 'project alpha',
        lang: 'en',
        script: 'Latn',
        context_summary: 'Slack mention in launch planning',
        related_surface_forms: ['Project Alpha JA'],
        timestamp_observed: 1710000000000,
        scope_kind: 'channel',
        scope_id: 'C1234567890',
        extractor_version: 'history-extractor@v1',
        embedding_model_version: 'multilingual-e5-large',
        source_connector: 'slack',
        source_raw_db_ref: '~/.mama/connectors/slack/raw.db',
        source_raw_record_id: 'raw_slack_001',
      });

      const second = await upsertEntityObservation({
        id: 'obs_project_alpha_1b',
        observation_type: 'generic',
        entity_kind_hint: 'project',
        surface_form: 'Project Alpha',
        normalized_form: 'project alpha',
        lang: 'en',
        script: 'Latn',
        context_summary: 'Updated Slack mention in launch planning',
        related_surface_forms: ['Project Alpha', 'Project Alpha JA'],
        timestamp_observed: 1710000000001,
        scope_kind: 'channel',
        scope_id: 'C1234567890',
        extractor_version: 'history-extractor@v1',
        embedding_model_version: 'multilingual-e5-large',
        source_connector: 'slack',
        source_raw_db_ref: '~/.mama/connectors/slack/raw.db',
        source_raw_record_id: 'raw_slack_001',
      });

      expect(first.id).toBe(second.id);
      expect(second.context_summary).toContain('Updated');
    });

    it('should keep distinct observation types for the same raw source record', async () => {
      const author = await upsertEntityObservation({
        id: 'obs_project_alpha_author',
        observation_type: 'author',
        entity_kind_hint: 'person',
        surface_form: 'Alice',
        normalized_form: 'alice',
        lang: 'en',
        script: 'Latn',
        context_summary: 'Slack mention in launch planning',
        related_surface_forms: ['Project Alpha'],
        timestamp_observed: 1710000000000,
        scope_kind: 'channel',
        scope_id: 'C1234567890',
        extractor_version: 'history-extractor@v1',
        embedding_model_version: 'multilingual-e5-large',
        source_connector: 'slack',
        source_raw_db_ref: '~/.mama/connectors/slack/raw.db',
        source_raw_record_id: 'raw_slack_002',
      });

      const project = await upsertEntityObservation({
        id: 'obs_project_alpha_channel',
        observation_type: 'channel',
        entity_kind_hint: 'project',
        surface_form: 'Project Alpha',
        normalized_form: 'project alpha',
        lang: 'en',
        script: 'Latn',
        context_summary: 'Slack mention in launch planning',
        related_surface_forms: ['Alice'],
        timestamp_observed: 1710000000000,
        scope_kind: 'channel',
        scope_id: 'C1234567890',
        extractor_version: 'history-extractor@v1',
        embedding_model_version: 'multilingual-e5-large',
        source_connector: 'slack',
        source_raw_db_ref: '~/.mama/connectors/slack/raw.db',
        source_raw_record_id: 'raw_slack_002',
      });

      expect(author.id).not.toBe(project.id);
      const count = getAdapter()
        .prepare(
          `
            SELECT COUNT(*) as total
            FROM entity_observations
            WHERE source_connector = ? AND source_raw_record_id = ?
          `
        )
        .get('slack', 'raw_slack_002') as { total: number };
      expect(count.total).toBe(2);
    });
  });

  describe('AC #5: observation row parsing validates malformed DB values', () => {
    it('should throw when required string fields are missing', () => {
      expect(() =>
        parseObservationRow({
          id: 'obs_invalid_required',
          observation_type: 'generic',
          entity_kind_hint: 'project',
          surface_form: 'Project Alpha',
          normalized_form: 'project alpha',
          lang: null,
          script: null,
          context_summary: null,
          related_surface_forms: '[]',
          timestamp_observed: null,
          scope_kind: 'channel',
          scope_id: 'C123',
          extractor_version: 'history-extractor@v1',
          embedding_model_version: null,
          source_raw_db_ref: null,
          source_connector: 'slack',
          source_raw_record_id: 42,
          created_at: Date.now(),
        } as unknown as Record<string, unknown>)
      ).toThrow(/source_raw_record_id/i);
    });

    it('should throw when related_surface_forms is malformed JSON', () => {
      expect(() =>
        parseObservationRow({
          id: 'obs_invalid_json',
          observation_type: 'generic',
          entity_kind_hint: 'project',
          surface_form: 'Project Alpha',
          normalized_form: 'project alpha',
          lang: null,
          script: null,
          context_summary: null,
          related_surface_forms: '{bad-json',
          timestamp_observed: null,
          scope_kind: 'channel',
          scope_id: 'C123',
          extractor_version: 'history-extractor@v1',
          embedding_model_version: null,
          source_connector: 'slack',
          source_raw_db_ref: null,
          source_raw_record_id: 'raw_slack_003',
          created_at: Date.now(),
        })
      ).toThrow(/related_surface_forms/i);
    });
  });
});
