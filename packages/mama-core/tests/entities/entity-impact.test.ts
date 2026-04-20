import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';
import { appendEntityLineageLink } from '../../src/entities/lineage-store.js';
import { createEntityNode, upsertEntityObservation } from '../../src/entities/store.js';
import { saveMemory } from '../../src/memory/api.js';

describe('Story E1.15: Entity inspector impact', () => {
  let testDbPath = '';
  const alphaKo = '\uC54C\uD30C \uD504\uB85C\uC81D\uD2B8';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-impact');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM decision_entity_sources').run();
    adapter.prepare('DELETE FROM decisions').run();
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_ingest_runs').run();
    adapter.prepare('DELETE FROM entity_audit_runs').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
  });

  async function seedInspectableEntity(): Promise<void> {
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
      context_summary: 'Kickoff decision',
      related_surface_forms: [alphaKo],
      timestamp_observed: 1710000000000,
      scope_kind: 'project',
      scope_id: 'scope-alpha',
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '/tmp/slack/raw.db',
      source_raw_record_id: 'raw_alpha',
    });
  }

  it('returns active lineage rows with raw evidence references', async () => {
    await seedInspectableEntity();
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

    const { listEntityLineageForInspector } = await import('../../src/entities/entity-impact.js');
    const result = await listEntityLineageForInspector('entity_project_alpha');

    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_observation_id: 'obs_project_alpha',
          source_connector: 'slack',
          source_raw_record_id: 'raw_alpha',
        }),
      ])
    );
    expect(result.history_incomplete).toBe(false);
  });

  it('returns related memories from decision_entity_sources', async () => {
    await seedInspectableEntity();
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
    const saved = await saveMemory({
      topic: 'project_alpha/kickoff',
      kind: 'decision',
      summary: 'Kickoff approved',
      details: 'Kickoff approved from entity evidence',
      confidence: 0.9,
      scopes: [{ kind: 'project', id: 'scope-alpha' }],
      source: { package: 'mama-core', source_type: 'test' },
      entityObservationIds: ['obs_project_alpha'],
    } as never);

    const { getEntityImpact } = await import('../../src/entities/entity-impact.js');
    const result = await getEntityImpact('entity_project_alpha');

    expect(result.related_memories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: saved.id })])
    );
  });

  it('reports history_incomplete when lineage is missing for current state', async () => {
    await seedInspectableEntity();

    const { getEntityInspectorDetail } = await import('../../src/entities/entity-impact.js');
    const result = await getEntityInspectorDetail('entity_project_alpha');

    expect(result.history_incomplete).toBe(true);
  });

  it('preserves nullable scope_kind values from entity_nodes', async () => {
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
        'entity_scope_null',
        'project',
        'Scope Null',
        'active',
        null,
        null,
        null,
        1710000000000,
        1710000000000
      );

    const { getEntityInspectorDetail } = await import('../../src/entities/entity-impact.js');
    const result = await getEntityInspectorDetail('entity_scope_null');

    expect(result.entity.scope_kind).toBeNull();
    expect(result.history_incomplete).toBe(true);
  });

  it('returns recent audit summaries and ingest-run context', async () => {
    await seedInspectableEntity();
    const adapter = getAdapter();
    adapter
      .prepare(
        `
          INSERT INTO entity_audit_runs (
            id, status, baseline_run_id, classification, metric_summary_json, reason, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'audit_superseded',
        'complete',
        null,
        'stable',
        JSON.stringify({ false_merge_rate: 0 }),
        'superseded only',
        1710000002000,
        1710000003000
      );
    adapter
      .prepare(
        `
          INSERT INTO entity_ingest_runs (
            id, connector, run_kind, status, scope_key, raw_count, observation_count,
            candidate_count, reviewable_count, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'eir_alpha',
        'slack',
        'replay',
        'complete',
        'slack:C123',
        3,
        1,
        1,
        1,
        1710000000000,
        1710000001000
      );
    await appendEntityLineageLink({
      canonical_entity_id: 'entity_project_alpha',
      entity_observation_id: 'obs_project_alpha',
      source_entity_id: null,
      contribution_kind: 'seed',
      run_id: 'eir_alpha',
      candidate_id: null,
      review_action_id: null,
      capture_mode: 'direct',
      confidence: 1,
    });
    adapter
      .prepare(
        `
          INSERT INTO entity_audit_runs (
            id, status, baseline_run_id, classification, metric_summary_json, reason, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'audit_alpha',
        'complete',
        null,
        'stable',
        JSON.stringify({ false_merge_rate: 0 }),
        'ok',
        1710000002000,
        1710000003000
      );
    adapter
      .prepare(`UPDATE entity_ingest_runs SET audit_run_id = ? WHERE id = ?`)
      .run('audit_alpha', 'eir_alpha');
    adapter
      .prepare(
        `
          INSERT INTO entity_audit_runs (
            id, status, baseline_run_id, classification, metric_summary_json, reason, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'audit_unrelated',
        'complete',
        null,
        'regressed',
        JSON.stringify({ false_merge_rate: 1 }),
        'unrelated',
        1710000004000,
        1710000005000
      );

    const { getEntityImpact } = await import('../../src/entities/entity-impact.js');
    const result = await getEntityImpact('entity_project_alpha');

    expect(result.ingest_runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'eir_alpha' })])
    );
    expect(result.audit_runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'audit_alpha', classification: 'stable' }),
      ])
    );
    expect(result.audit_runs.map((run) => run.id)).not.toContain('audit_unrelated');
  });

  it('ignores ingest and audit runs that are only reachable through superseded lineage', async () => {
    await seedInspectableEntity();
    const adapter = getAdapter();
    adapter
      .prepare(
        `
          INSERT INTO entity_audit_runs (
            id, status, baseline_run_id, classification, metric_summary_json, reason, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'audit_superseded',
        'complete',
        null,
        'stable',
        JSON.stringify({ false_merge_rate: 0 }),
        'superseded only',
        1710000002000,
        1710000003000
      );
    adapter
      .prepare(
        `
          INSERT INTO entity_ingest_runs (
            id, connector, run_kind, status, scope_key, raw_count, observation_count,
            candidate_count, reviewable_count, created_at, completed_at, audit_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'eir_superseded',
        'slack',
        'replay',
        'complete',
        'slack:C999',
        1,
        1,
        0,
        0,
        1710000000000,
        1710000001000,
        'audit_superseded'
      );
    adapter
      .prepare(
        `
          INSERT INTO entity_lineage_links (
            id, canonical_entity_id, entity_observation_id, source_entity_id, contribution_kind,
            run_id, candidate_id, review_action_id, status, capture_mode, confidence, created_at, superseded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'elin_superseded_only',
        'entity_project_alpha',
        'obs_project_alpha',
        null,
        'seed',
        'eir_superseded',
        null,
        null,
        'superseded',
        'direct',
        1,
        1710000000000,
        1710000004000
      );

    const { getEntityImpact } = await import('../../src/entities/entity-impact.js');
    const result = await getEntityImpact('entity_project_alpha');

    expect(result.ingest_runs.map((run) => run.id)).not.toContain('eir_superseded');
    expect(result.audit_runs.map((run) => run.id)).not.toContain('audit_superseded');
  });

  it('clamps inspector lineage limits to a positive bounded value', async () => {
    await seedInspectableEntity();
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

    const { listEntityLineageForInspector } = await import('../../src/entities/entity-impact.js');
    const result = await listEntityLineageForInspector('entity_project_alpha', 0);

    expect(result.rows).toHaveLength(1);
    expect(result.history_incomplete).toBe(false);
  });
});
