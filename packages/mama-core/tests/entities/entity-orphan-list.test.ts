import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { appendEntityLineageLink } from '../../src/entities/lineage-store.js';
import { saveMemory } from '../../src/memory/api.js';
import { createEntityNode, upsertEntityObservation } from '../../src/entities/store.js';
import { getAdapter } from '../../src/db-manager.js';

describe('canonical entity orphan list', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-orphan-list');
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

  it('lists active lineage-backed zero-linked entities with evidence counts in deterministic order', async () => {
    await seedOrphanEntity({
      entityId: 'entity_project_orphan_b',
      label: 'Project Orphan B',
      scopeId: 'scope-orphan',
      observedAt: 1710000001000,
    });
    await seedOrphanEntity({
      entityId: 'entity_project_orphan_a',
      label: 'Project Orphan A',
      scopeId: 'scope-orphan',
      observedAt: 1710000001000,
    });

    const { listCanonicalEntityOrphans } = await import('../../src/entities/entity-orphan-list.js');
    const rows = await listCanonicalEntityOrphans();

    expect(rows.map((row) => row.entity_id)).toEqual([
      'entity_project_orphan_a',
      'entity_project_orphan_b',
    ]);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        title: 'Project Orphan A',
        kind: 'project',
        scope_label: 'project:scope-orphan',
        linked_decision_count: 0,
        evidence_summary: {
          lineage_rows: 1,
          raw_evidence_rows: 1,
          last_seen_at: 1710000001000,
        },
      })
    );
  });

  it('excludes linked, noisy, merged, and inactive entities from the orphan list', async () => {
    await seedOrphanEntity({
      entityId: 'entity_project_visible',
      label: 'Visible Orphan',
      scopeId: 'scope-visible',
      observedAt: 1710000000000,
    });
    await seedOrphanEntity({
      entityId: 'entity_person_user',
      label: 'user',
      scopeId: 'workspace',
      observedAt: 1710000000100,
      kind: 'person',
      scopeKind: 'channel',
    });
    await seedOrphanEntity({
      entityId: 'entity_project_merged',
      label: 'Merged Orphan',
      scopeId: 'scope-merged',
      observedAt: 1710000000200,
      mergedInto: 'entity_project_visible',
    });
    await seedOrphanEntity({
      entityId: 'entity_project_inactive',
      label: 'Inactive Orphan',
      scopeId: 'scope-inactive',
      observedAt: 1710000000300,
      status: 'merged',
    });
    await seedLinkedEntity();

    const { listCanonicalEntityOrphans } = await import('../../src/entities/entity-orphan-list.js');
    const rows = await listCanonicalEntityOrphans();

    expect(rows.map((row) => row.entity_id)).toEqual(['entity_project_visible']);
  });
});

async function seedOrphanEntity(input: {
  entityId: string;
  label: string;
  scopeId: string;
  observedAt: number;
  kind?: 'project' | 'person';
  scopeKind?: 'project' | 'channel';
  status?: 'active' | 'merged';
  mergedInto?: string | null;
}): Promise<void> {
  await createEntityNode({
    id: input.entityId,
    kind: input.kind ?? 'project',
    preferred_label: input.label,
    status: input.status ?? 'active',
    scope_kind: input.scopeKind ?? 'project',
    scope_id: input.scopeId,
    merged_into: input.mergedInto ?? null,
  });
  await upsertEntityObservation({
    id: `obs_${input.entityId}`,
    observation_type: 'generic',
    entity_kind_hint: input.kind ?? 'project',
    surface_form: input.label,
    normalized_form: input.label.toLowerCase(),
    lang: 'en',
    script: 'Latn',
    context_summary: `${input.label} evidence`,
    related_surface_forms: [input.label],
    timestamp_observed: input.observedAt,
    scope_kind: input.scopeKind ?? 'project',
    scope_id: input.scopeId,
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'slack',
    source_locator: '/tmp/slack/raw.db',
    source_raw_record_id: `raw_${input.entityId}`,
  });
  await appendEntityLineageLink({
    canonical_entity_id: input.entityId,
    entity_observation_id: `obs_${input.entityId}`,
    source_entity_id: null,
    contribution_kind: 'seed',
    run_id: null,
    candidate_id: null,
    review_action_id: null,
    capture_mode: 'direct',
    confidence: 1,
  });
}

async function seedLinkedEntity(): Promise<void> {
  await createEntityNode({
    id: 'entity_project_linked',
    kind: 'project',
    preferred_label: 'Linked Project',
    status: 'active',
    scope_kind: 'project',
    scope_id: 'scope-linked',
    merged_into: null,
  });
  await upsertEntityObservation({
    id: 'obs_entity_project_linked',
    observation_type: 'generic',
    entity_kind_hint: 'project',
    surface_form: 'Linked Project',
    normalized_form: 'linked project',
    lang: 'en',
    script: 'Latn',
    context_summary: 'Linked project evidence',
    related_surface_forms: ['Linked Project'],
    timestamp_observed: 1710000000400,
    scope_kind: 'project',
    scope_id: 'scope-linked',
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'slack',
    source_locator: '/tmp/slack/raw.db',
    source_raw_record_id: 'raw_entity_project_linked',
  });
  await appendEntityLineageLink({
    canonical_entity_id: 'entity_project_linked',
    entity_observation_id: 'obs_entity_project_linked',
    source_entity_id: null,
    contribution_kind: 'seed',
    run_id: null,
    candidate_id: null,
    review_action_id: null,
    capture_mode: 'direct',
    confidence: 1,
  });
  await saveMemory({
    topic: 'linked/project',
    kind: 'decision',
    summary: 'Linked project should not be orphaned',
    details: 'linked project decision',
    confidence: 0.9,
    scopes: [{ kind: 'project', id: 'scope-linked' }],
    source: { package: 'mama-core', source_type: 'test' },
    entityObservationIds: ['obs_entity_project_linked'],
  } as never);
}
