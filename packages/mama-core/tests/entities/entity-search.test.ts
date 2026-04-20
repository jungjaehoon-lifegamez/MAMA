import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { attachEntityAlias, createEntityNode } from '../../src/entities/store.js';
import { getAdapter } from '../../src/db-manager.js';
import { appendEntityLineageLink } from '../../src/entities/lineage-store.js';
import { upsertEntityObservation } from '../../src/entities/store.js';
import { saveMemory } from '../../src/memory/api.js';

describe('Story E1.14: Entity search', () => {
  let testDbPath = '';
  const alphaKo = '\uC54C\uD30C \uD504\uB85C\uC81D\uD2B8';
  const alphaKoQuery = '\uC54C\uD30C';
  const alphaJa = '\u30A2\u30EB\u30D5\u30A1\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-search');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM decision_entity_sources').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM memory_scopes').run();
    adapter.prepare('DELETE FROM decisions').run();
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_aliases').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
  });

  async function seedEntity(
    id: string,
    preferredLabel: string,
    aliases: Array<{ id: string; label: string }>
  ): Promise<void> {
    await createEntityNode({
      id,
      kind: 'project',
      preferred_label: preferredLabel,
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-search',
      merged_into: null,
    });
    for (const alias of aliases) {
      await attachEntityAlias({
        id: alias.id,
        entity_id: id,
        label: alias.label,
        normalized_label: alias.label.toLowerCase(),
        lang: null,
        script: null,
        label_type: 'alt',
        source_type: 'synthetic',
        source_ref: 'synthetic:test',
        confidence: 0.9,
        status: 'active',
      });
    }
  }

  it('finds one canonical entity from Korean/English/Japanese aliases', async () => {
    await seedEntity('entity_project_alpha', 'Project Alpha', [
      { id: 'alias_alpha_ko', label: alphaKo },
      { id: 'alias_alpha_ja', label: alphaJa },
    ]);

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: alphaKoQuery, limit: 10 });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toEqual(
      expect.objectContaining({
        id: 'entity_project_alpha',
        preferred_label: 'Project Alpha',
      })
    );
  });

  it('paginates search results with stable ranking', async () => {
    await seedEntity('entity_project_alpha', 'Project Alpha', []);
    await seedEntity('entity_project_beta', 'Project Beta', []);

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const first = await searchCanonicalEntities({ query: 'Project', limit: 1 });

    expect(first.entities).toHaveLength(1);
    expect(typeof first.next_cursor).toBe('string');

    const second = await searchCanonicalEntities({
      query: 'Project',
      limit: 1,
      cursor: first.next_cursor,
    });

    expect(second.entities).toHaveLength(1);
    expect(second.entities[0]?.id).not.toBe(first.entities[0]?.id);
  });

  it('skips merged tombstones from primary results', async () => {
    await createEntityNode({
      id: 'entity_project_live',
      kind: 'project',
      preferred_label: 'Project Live',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-search',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_project_merged',
      kind: 'project',
      preferred_label: 'Project Merged',
      status: 'merged',
      scope_kind: 'project',
      scope_id: 'scope-search',
      merged_into: 'entity_project_live',
    });

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: 'Project', limit: 10 });

    expect(result.entities.map((item) => item.id)).not.toContain('entity_project_merged');
  });

  it('surfaces merged labels through canonical resolution', async () => {
    await createEntityNode({
      id: 'entity_target_alias',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-search',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_source_alias',
      kind: 'project',
      preferred_label: 'Old Alpha Name',
      status: 'merged',
      scope_kind: 'project',
      scope_id: 'scope-search',
      merged_into: 'entity_target_alias',
    });
    await attachEntityAlias({
      id: 'alias_old_alpha',
      entity_id: 'entity_source_alias',
      label: 'Legacy Alpha',
      normalized_label: 'legacy alpha',
      lang: 'en',
      script: 'Latn',
      label_type: 'alt',
      source_type: 'synthetic',
      source_ref: 'synthetic:test',
      confidence: 0.9,
      status: 'active',
    });

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: 'Legacy Alpha', limit: 10 });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe('entity_target_alias');
  });

  it('collapses exact same-scope duplicate canonicals into one search result', async () => {
    await createEntityNode({
      id: 'entity_calendar_a',
      kind: 'project',
      preferred_label: 'calendar',
      status: 'active',
      scope_kind: 'channel',
      scope_id: 'calendar',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_calendar_b',
      kind: 'project',
      preferred_label: 'calendar',
      status: 'active',
      scope_kind: 'channel',
      scope_id: 'calendar',
      merged_into: null,
    });

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: 'calendar', limit: 10 });

    expect(result.entities).toHaveLength(1);
  });

  it('finds a canonical entity through active lineage observation surface forms', async () => {
    await createEntityNode({
      id: 'entity_project_alpha_lineage',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-search',
      merged_into: null,
    });
    await upsertEntityObservation({
      id: 'obs_project_alpha_ko',
      observation_type: 'channel',
      entity_kind_hint: 'project',
      surface_form: alphaKo,
      normalized_form: alphaKo,
      lang: 'ko',
      script: 'Hang',
      context_summary: 'alpha kickoff',
      related_surface_forms: ['Project Alpha'],
      timestamp_observed: 1710000000000,
      scope_kind: 'project',
      scope_id: 'scope-search',
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '~/.mama/connectors/slack/raw.db',
      source_raw_record_id: 'raw_lineage_alpha',
    });
    await appendEntityLineageLink({
      canonical_entity_id: 'entity_project_alpha_lineage',
      entity_observation_id: 'obs_project_alpha_ko',
      source_entity_id: null,
      contribution_kind: 'seed',
      run_id: null,
      candidate_id: null,
      review_action_id: null,
      capture_mode: 'direct',
      confidence: 1,
    });

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: alphaKoQuery, limit: 10 });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe('entity_project_alpha_lineage');
  });

  it('returns linked decision counts for lineage-backed search results', async () => {
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-search',
      merged_into: null,
    });
    await upsertEntityObservation({
      id: 'obs_project_alpha',
      observation_type: 'generic',
      entity_kind_hint: 'project',
      surface_form: 'Project Alpha',
      normalized_form: 'project alpha',
      lang: 'en',
      script: 'Latn',
      context_summary: 'Alpha kickoff',
      related_surface_forms: ['Alpha'],
      timestamp_observed: 1710000000000,
      scope_kind: 'project',
      scope_id: 'scope-search',
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '/tmp/slack/raw.db',
      source_raw_record_id: 'raw_alpha',
    });
    await appendEntityLineageLink({
      canonical_entity_id: 'entity_project_alpha',
      entity_observation_id: 'obs_project_alpha',
      source_entity_id: null,
      contribution_kind: 'seed',
      run_id: null,
      candidate_id: null,
      review_action_id: null,
      capture_mode: 'direct',
      confidence: 1,
    });
    await saveMemory({
      topic: 'project_alpha/search',
      kind: 'decision',
      summary: 'Search linked to entity evidence',
      details: 'Search should expose linked memory count',
      confidence: 0.9,
      scopes: [{ kind: 'project', id: 'scope-search' }],
      source: { package: 'mama-core', source_type: 'test' },
      entityObservationIds: ['obs_project_alpha'],
    } as never);

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: 'Alpha', limit: 10 });

    expect(result.entities[0]).toEqual(
      expect.objectContaining({
        id: 'entity_project_alpha',
        linked_decision_count: 1,
      })
    );
  });

  it('treats literal percent characters as exact search text', async () => {
    await seedEntity('entity_percent', '100% Coverage', []);
    await seedEntity('entity_plain_percent', '100 Percent Coverage', []);

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: '%', limit: 10 });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe('entity_percent');
  });

  it('treats literal underscore characters as exact search text', async () => {
    await seedEntity('entity_underscore', 'alpha_beta', []);
    await seedEntity('entity_plain_underscore', 'alpha beta', []);

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: '_', limit: 10 });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe('entity_underscore');
  });

  it('treats literal backslashes as exact search text', async () => {
    await seedEntity('entity_backslash', 'alpha\\beta', []);
    await seedEntity('entity_plain_backslash', 'alpha beta', []);

    const { searchCanonicalEntities } = await import('../../src/entities/entity-search.js');
    const result = await searchCanonicalEntities({ query: '\\', limit: 10 });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe('entity_backslash');
  });
});
