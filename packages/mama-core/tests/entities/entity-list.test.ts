import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { appendEntityLineageLink } from '../../src/entities/lineage-store.js';
import { saveMemory } from '../../src/memory/api.js';
import { createEntityNode, upsertEntityObservation } from '../../src/entities/store.js';
import { getAdapter } from '../../src/db-manager.js';

describe('Story E1.17: Canonical entity browse list', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-list');
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

  it('lists active canonical entities in reverse creation order', async () => {
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-list',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_person_bora',
      kind: 'person',
      preferred_label: 'Bora',
      status: 'active',
      scope_kind: 'channel',
      scope_id: 'workspace',
      merged_into: null,
    });

    const { listCanonicalEntities } = await import('../../src/entities/entity-list.js');
    const result = await listCanonicalEntities({ limit: 10, include_noisy: true });

    expect(result.entities.map((entity) => entity.id)).toEqual([
      'entity_person_bora',
      'entity_project_alpha',
    ]);
    expect(result.total_count).toBe(2);
    expect(result.visible_count).toBe(2);
  });

  it('hides known noisy workspace metadata entities when requested', async () => {
    await createEntityNode({
      id: 'entity_person_user',
      kind: 'person',
      preferred_label: 'user',
      status: 'active',
      scope_kind: 'channel',
      scope_id: 'workspace',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_person_claude',
      kind: 'person',
      preferred_label: 'claude',
      status: 'active',
      scope_kind: 'channel',
      scope_id: 'workspace',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_project_workspace',
      kind: 'project',
      preferred_label: 'workspace',
      status: 'active',
      scope_kind: 'channel',
      scope_id: 'workspace',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-list',
      merged_into: null,
    });

    const { listCanonicalEntities } = await import('../../src/entities/entity-list.js');
    const result = await listCanonicalEntities({ limit: 10, include_noisy: false });

    expect(result.entities.map((entity) => entity.id)).toEqual(['entity_project_alpha']);
    expect(result.total_count).toBe(4);
    expect(result.visible_count).toBe(1);
  });

  it('paginates filtered canonical browse results with a stable cursor', async () => {
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-list',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_project_beta',
      kind: 'project',
      preferred_label: 'Project Beta',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-list',
      merged_into: null,
    });

    const { listCanonicalEntities } = await import('../../src/entities/entity-list.js');
    const first = await listCanonicalEntities({ limit: 1, include_noisy: true });
    const second = await listCanonicalEntities({
      limit: 1,
      include_noisy: true,
      cursor: first.next_cursor,
    });

    expect(first.entities).toHaveLength(1);
    expect(typeof first.next_cursor).toBe('string');
    expect(second.entities).toHaveLength(1);
    expect(second.entities[0]?.id).not.toBe(first.entities[0]?.id);
  });

  it('collapses exact same-scope duplicates into one browse row', async () => {
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
        'entity_calendar_a',
        'project',
        'calendar',
        'active',
        'channel',
        'calendar',
        null,
        1710000000000,
        1710000000000
      );
    adapter
      .prepare(
        `
          INSERT INTO entity_nodes (
            id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'entity_calendar_b',
        'project',
        'calendar',
        'active',
        'channel',
        'calendar',
        null,
        1710000001000,
        1710000001000
      );

    const { listCanonicalEntities } = await import('../../src/entities/entity-list.js');
    const result = await listCanonicalEntities({ limit: 10, include_noisy: true });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.id).toBe('entity_calendar_b');
    expect(result.total_count).toBe(2);
    expect(result.visible_count).toBe(1);
  });

  it('includes linked decision counts for active lineage-backed memories', async () => {
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-alpha',
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
      scope_id: 'scope-alpha',
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
      topic: 'project_alpha/kickoff',
      kind: 'decision',
      summary: 'Kickoff approved',
      details: 'Kickoff approved from entity evidence',
      confidence: 0.9,
      scopes: [{ kind: 'project', id: 'scope-alpha' }],
      source: { package: 'mama-core', source_type: 'test' },
      entityObservationIds: ['obs_project_alpha'],
    } as never);

    const { listCanonicalEntities } = await import('../../src/entities/entity-list.js');
    const result = await listCanonicalEntities({ limit: 10, include_noisy: true });

    expect(result.entities[0]).toEqual(
      expect.objectContaining({
        id: 'entity_project_alpha',
        linked_decision_count: 1,
      })
    );
  });
});
