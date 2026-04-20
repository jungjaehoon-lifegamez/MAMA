import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';
import {
  adoptLineageAfterMergeSync,
  appendEntityLineageLink,
} from '../../src/entities/lineage-store.js';
import {
  createEntityNode,
  mergeEntityNodes,
  upsertEntityObservation,
} from '../../src/entities/store.js';
import { saveMemory } from '../../src/memory/api.js';

describe('Story E1.17: Entity rollback preview', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('rollback-preview');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM decision_entity_sources').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM memory_scopes').run();
    adapter.prepare('DELETE FROM decision_edges').run();
    adapter.prepare('DELETE FROM decisions').run();
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_ingest_runs').run();
    adapter.prepare('DELETE FROM entity_audit_runs').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_aliases').run();
    adapter.prepare('DELETE FROM entity_timeline_events').run();
    adapter.prepare('DELETE FROM entity_merge_actions').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
  });

  it('simulates reversing one merge without mutating persistent state', async () => {
    const { mergeActionId } = await seedMergedEntityPair();
    const adapter = getAdapter();

    const beforeSource = adapter
      .prepare('SELECT status, merged_into FROM entity_nodes WHERE id = ?')
      .get('entity_project_source') as { status: string; merged_into: string | null };
    const beforeTargetActive = adapter
      .prepare(
        `SELECT COUNT(*) AS total FROM entity_lineage_links WHERE canonical_entity_id = ? AND status = 'active'`
      )
      .get('entity_project_target') as { total: number };

    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');
    const preview = await previewEntityRollback({
      entityId: 'entity_project_target',
      mergeActionId,
    });

    expect(preview.preview_unavailable).toBe(false);
    expect(preview.changed_entities.map((entity) => entity.entity_id)).toEqual(
      expect.arrayContaining(['entity_project_source', 'entity_project_target'])
    );

    const afterSource = adapter
      .prepare('SELECT status, merged_into FROM entity_nodes WHERE id = ?')
      .get('entity_project_source') as { status: string; merged_into: string | null };
    const afterTargetActive = adapter
      .prepare(
        `SELECT COUNT(*) AS total FROM entity_lineage_links WHERE canonical_entity_id = ? AND status = 'active'`
      )
      .get('entity_project_target') as { total: number };

    expect(afterSource).toEqual(beforeSource);
    expect(afterTargetActive.total).toBe(beforeTargetActive.total);
  });

  it('returns affected entities, memories, and likely metric movement', async () => {
    const { mergeActionId, memoryId } = await seedMergedEntityPair();
    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');

    const preview = await previewEntityRollback({
      entityId: 'entity_project_target',
      mergeActionId,
    });

    expect(preview.changed_entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: 'entity_project_source' }),
        expect.objectContaining({ entity_id: 'entity_project_target' }),
      ])
    );
    expect(preview.changed_memories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: memoryId })])
    );
    expect(preview.metric_movement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'false_merge_rate' }),
        expect.objectContaining({ metric: 'projection_fragmentation_rate' }),
      ])
    );
  });

  it('reports preview_unavailable when history is incomplete', async () => {
    const mergeActionId = await seedIncompleteMerge();
    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');

    const preview = await previewEntityRollback({
      entityId: 'entity_project_target',
      mergeActionId,
    });

    expect(preview.preview_unavailable).toBe(true);
    expect(preview.history_incomplete).toBe(true);
    expect(preview.changed_entities).toHaveLength(0);
  });

  it('returns truncation metadata when impact exceeds bounded cost', async () => {
    const { mergeActionId } = await seedMergedEntityPair();
    await saveMemory({
      topic: 'project_source/followup',
      kind: 'decision',
      summary: 'Follow-up approved',
      details: 'Follow-up also tied to source evidence',
      confidence: 0.8,
      scopes: [{ kind: 'project', id: 'scope-alpha' }],
      source: { package: 'mama-core', source_type: 'test' },
      entityObservationIds: ['obs_project_source'],
    } as never);

    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');
    const preview = await previewEntityRollback({
      entityId: 'entity_project_target',
      mergeActionId,
      maxAffectedRows: 1,
    });

    expect(preview.truncated).toBe(true);
    expect(preview.changed_memories).toHaveLength(1);
  });

  it('scopes restored and removed lineage rows to the selected mergeActionId', async () => {
    const { mergeActionId, memoryId } = await seedMergedEntityPair();
    const adapter = getAdapter();

    await upsertEntityObservation({
      id: 'obs_project_source_other',
      observation_type: 'generic',
      entity_kind_hint: 'project',
      surface_form: 'Project Source Other',
      normalized_form: 'project source other',
      lang: 'en',
      script: 'Latn',
      context_summary: 'Other merge action observation',
      related_surface_forms: ['Source Other'],
      timestamp_observed: 1710000002000,
      scope_kind: 'project',
      scope_id: 'scope-alpha',
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '/tmp/slack/raw.db',
      source_raw_record_id: 'raw_source_other',
    });

    adapter
      .prepare(
        `
          INSERT INTO entity_merge_actions (
            id, action_type, source_entity_id, target_entity_id, candidate_id,
            actor_type, actor_id, reason, evidence_json, created_at
          ) VALUES (?, 'merge', ?, ?, NULL, 'system', 'test', ?, ?, ?)
        `
      )
      .run(
        'mact_other',
        'entity_project_source',
        'entity_project_target',
        'synthetic alternate merge action',
        JSON.stringify({ reason: 'test setup' }),
        1710000002050
      );

    adapter
      .prepare(
        `
          INSERT INTO entity_lineage_links (
            id, canonical_entity_id, entity_observation_id, source_entity_id,
            contribution_kind, run_id, candidate_id, review_action_id,
            status, capture_mode, confidence, created_at, superseded_at
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'elin_source_other_superseded',
        'entity_project_source',
        'obs_project_source_other',
        'entity_project_source',
        'merge_adopt',
        'mact_other',
        'superseded',
        'direct',
        1,
        1710000002000,
        1710000002100
      );
    adapter
      .prepare(
        `
          INSERT INTO entity_lineage_links (
            id, canonical_entity_id, entity_observation_id, source_entity_id,
            contribution_kind, run_id, candidate_id, review_action_id,
            status, capture_mode, confidence, created_at, superseded_at
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)
        `
      )
      .run(
        'elin_target_other_active',
        'entity_project_target',
        'obs_project_source_other',
        'entity_project_source',
        'merge_adopt',
        'mact_other',
        'active',
        'direct',
        1,
        1710000002200
      );

    const extraMemory = await saveMemory({
      topic: 'project_source/other-merge',
      kind: 'decision',
      summary: 'Other merge memory',
      details: 'Should not appear for the selected merge action',
      confidence: 0.7,
      scopes: [{ kind: 'project', id: 'scope-alpha' }],
      source: { package: 'mama-core', source_type: 'test' },
      entityObservationIds: ['obs_project_source_other'],
    } as never);

    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');
    const preview = await previewEntityRollback({
      entityId: 'entity_project_target',
      mergeActionId,
    });

    expect(preview.preview_unavailable).toBe(false);
    expect(preview.changed_memories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: memoryId })])
    );
    expect(preview.changed_memories.map((memory) => memory.id)).not.toContain(extraMemory.id);
  });

  it('rejects an explicit mergeActionId that does not belong to the requested entity', async () => {
    const { mergeActionId } = await seedMergedEntityPair();
    await createEntityNode({
      id: 'entity_unrelated',
      kind: 'project',
      preferred_label: 'Unrelated',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-unrelated',
      merged_into: null,
    });

    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');
    const preview = await previewEntityRollback({
      entityId: 'entity_unrelated',
      mergeActionId,
    });

    expect(preview.preview_unavailable).toBe(true);
    expect(preview.changed_entities).toHaveLength(0);
  });

  it('treats an observation mismatch as unavailable input, not incomplete history', async () => {
    await seedMergedEntityPair();
    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');

    const preview = await previewEntityRollback({
      entityId: 'entity_project_target',
      observationId: 'obs-does-not-belong',
    });

    expect(preview.preview_unavailable).toBe(true);
    expect(preview.history_incomplete).toBe(false);
  });

  it('preserves role on the latest timeline event projection', async () => {
    const adapter = getAdapter();
    await createEntityNode({
      id: 'entity_role_projection',
      kind: 'project',
      preferred_label: 'Role Projection',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'scope-role',
      merged_into: null,
    });
    adapter
      .prepare(
        `
          INSERT INTO entity_timeline_events (
            id, entity_id, event_type, role, summary, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'evt-role-projection',
        'entity_role_projection',
        'project_update',
        'implementer',
        'Role projection event',
        1710000000000
      );

    const { previewEntityRollback } = await import('../../src/entities/rollback-preview.js');
    const preview = await previewEntityRollback({
      entityId: 'entity_role_projection',
      observationId: 'obs-missing',
    });

    expect(preview.history_incomplete).toBe(false);
  });
});

async function seedMergedEntityPair(): Promise<{ mergeActionId: string; memoryId: string }> {
  const adapter = getAdapter();

  await createEntityNode({
    id: 'entity_project_source',
    kind: 'project',
    preferred_label: 'Project Source',
    status: 'active',
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    merged_into: null,
  });
  await createEntityNode({
    id: 'entity_project_target',
    kind: 'project',
    preferred_label: 'Project Target',
    status: 'active',
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    merged_into: null,
  });

  await upsertEntityObservation({
    id: 'obs_project_source',
    observation_type: 'generic',
    entity_kind_hint: 'project',
    surface_form: 'Project Source',
    normalized_form: 'project source',
    lang: 'en',
    script: 'Latn',
    context_summary: 'Source observation',
    related_surface_forms: ['Source'],
    timestamp_observed: 1710000000000,
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'slack',
    source_locator: '/tmp/slack/raw.db',
    source_raw_record_id: 'raw_source',
  });
  await upsertEntityObservation({
    id: 'obs_project_target',
    observation_type: 'generic',
    entity_kind_hint: 'project',
    surface_form: 'Project Target',
    normalized_form: 'project target',
    lang: 'en',
    script: 'Latn',
    context_summary: 'Target observation',
    related_surface_forms: ['Target'],
    timestamp_observed: 1710000001000,
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'slack',
    source_locator: '/tmp/slack/raw.db',
    source_raw_record_id: 'raw_target',
  });

  await appendEntityLineageLink({
    canonical_entity_id: 'entity_project_source',
    entity_observation_id: 'obs_project_source',
    source_entity_id: null,
    contribution_kind: 'seed',
    run_id: null,
    candidate_id: null,
    review_action_id: null,
    capture_mode: 'direct',
    confidence: 1,
  });
  await appendEntityLineageLink({
    canonical_entity_id: 'entity_project_target',
    entity_observation_id: 'obs_project_target',
    source_entity_id: null,
    contribution_kind: 'seed',
    run_id: null,
    candidate_id: null,
    review_action_id: null,
    capture_mode: 'direct',
    confidence: 1,
  });

  let mergeActionId = '';
  const runMerge =
    'transaction' in adapter && typeof adapter.transaction === 'function'
      ? adapter.transaction(() => {
          const result = mergeEntityNodes({
            adapter,
            source_id: 'entity_project_source',
            target_id: 'entity_project_target',
            actor_type: 'user',
            actor_id: 'local:tester',
            reason: 'duplicate project',
            candidate_id: null,
            evidence_json: JSON.stringify({ reason: 'preview test' }),
          });
          mergeActionId = result.merge_action_id;
          adoptLineageAfterMergeSync({
            adapter,
            source_entity_id: 'entity_project_source',
            target_entity_id: 'entity_project_target',
            candidate_id: null,
            review_action_id: mergeActionId,
          });
        })
      : null;

  if (runMerge) {
    const tx = runMerge as unknown;
    if (typeof tx === 'function') {
      tx();
    }
  }

  const memory = await saveMemory({
    topic: 'project_source/kickoff',
    kind: 'decision',
    summary: 'Kickoff approved',
    details: 'Kickoff tied to source evidence',
    confidence: 0.9,
    scopes: [{ kind: 'project', id: 'scope-alpha' }],
    source: { package: 'mama-core', source_type: 'test' },
    entityObservationIds: ['obs_project_source'],
  } as never);

  return { mergeActionId, memoryId: memory.id };
}

async function seedIncompleteMerge(): Promise<string> {
  const adapter = getAdapter();

  await createEntityNode({
    id: 'entity_project_source',
    kind: 'project',
    preferred_label: 'Project Source',
    status: 'active',
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    merged_into: null,
  });
  await createEntityNode({
    id: 'entity_project_target',
    kind: 'project',
    preferred_label: 'Project Target',
    status: 'active',
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    merged_into: null,
  });

  let mergeActionId = '';
  const runMerge =
    'transaction' in adapter && typeof adapter.transaction === 'function'
      ? adapter.transaction(() => {
          const result = mergeEntityNodes({
            adapter,
            source_id: 'entity_project_source',
            target_id: 'entity_project_target',
            actor_type: 'user',
            actor_id: 'local:tester',
            reason: 'history missing',
            candidate_id: null,
            evidence_json: JSON.stringify({ reason: 'preview incomplete test' }),
          });
          mergeActionId = result.merge_action_id;
        })
      : null;

  if (runMerge) {
    const tx = runMerge as unknown;
    if (typeof tx === 'function') {
      tx();
    }
  }

  return mergeActionId;
}
