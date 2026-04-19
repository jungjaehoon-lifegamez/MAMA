import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { initDB } from '../../src/db-manager.js';
import { createEntityNode, upsertEntityObservation } from '../../src/entities/store.js';
import { appendEntityLineageLink } from '../../src/entities/lineage-store.js';
import { saveMemory } from '../../src/memory/api.js';
import {
  loadDecisionReadIdentityIndex,
  resolveReadIdentity,
  type CanonicalReadEntity,
} from '../../src/entities/read-identity.js';
import type { MemoryRecord } from '../../src/memory/types.js';

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'decision_alpha',
    topic: 'project_alpha/status',
    kind: 'decision',
    summary: 'Kickoff approved',
    details: 'Kickoff approved',
    confidence: 0.9,
    status: 'active',
    scopes: [{ kind: 'project', id: 'alpha' }],
    source: { package: 'mama-core', source_type: 'db' },
    created_at: 1_710_000_000_000,
    updated_at: 1_710_000_000_000,
    ...overrides,
  };
}

describe('resolveReadIdentity', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('read-identity');
    process.env.MAMA_DB_PATH = testDbPath;
    await initDB();
  });

  afterAll(async () => {
    delete process.env.MAMA_DB_PATH;
    await cleanupTestDB(testDbPath);
  });

  beforeEach(async () => {
    const { getAdapter } = await import('../../src/db-manager.js');
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM decision_entity_sources').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM memory_scopes').run();
    adapter.prepare('DELETE FROM decisions').run();
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
    adapter.prepare('DELETE FROM entity_observations').run();
  });

  it('returns canonical and stable-sorts entities when active bindings exist', () => {
    const entities: CanonicalReadEntity[] = [
      { id: 'entity_user_sample', label: 'Jeong Jaehun', kind: 'person' },
      { id: 'entity_project_alpha', label: 'Project Alpha', kind: 'project' },
    ];

    const result = resolveReadIdentity(makeMemory(), entities);

    expect(result.kind).toBe('canonical');
    if (result.kind !== 'canonical') {
      throw new Error('Expected canonical read identity');
    }
    expect(result.entities).toEqual([
      { id: 'entity_user_sample', label: 'Jeong Jaehun', kind: 'person' },
      { id: 'entity_project_alpha', label: 'Project Alpha', kind: 'project' },
    ]);
    expect(result.primaryEntity.id).toBe('entity_user_sample');
    expect(result.legacyTopic).toBe('project_alpha/status');
    expect(result.displaySubject).toBe('Project Alpha');
    expect(result.displayTopic).toBe('project alpha / status');
    expect(result.displaySuffix).toBe('status');
  });

  it('returns topic when no canonical entity binding exists', () => {
    const result = resolveReadIdentity(makeMemory(), []);

    expect(result).toEqual({
      kind: 'topic',
      topic: 'project_alpha/status',
      displaySubject: null,
      displayTopic: 'project alpha / status',
      displaySuffix: null,
    });
  });

  it('returns raw when neither canonical binding nor topic exists', () => {
    const result = resolveReadIdentity(
      makeMemory({
        topic: '',
        summary: 'Loose summary only',
      }),
      []
    );

    expect(result).toEqual({
      kind: 'raw',
      label: 'Loose summary only',
      displaySubject: null,
      displayTopic: 'Loose summary only',
      displaySuffix: null,
    });
  });

  it('marks canonical/topic disagreement as shadow conflict', () => {
    const result = resolveReadIdentity(makeMemory(), [
      { id: 'entity_project_alpha', label: 'Project Alpha', kind: 'project' },
    ]);

    expect(result.kind).toBe('canonical');
    if (result.kind !== 'canonical') {
      throw new Error('Expected canonical read identity');
    }
    expect(result.shadowConflict).toBe(true);
  });

  it('prefers a topic namespace as display subject when the project label looks like a participant room', () => {
    const result = resolveReadIdentity(
      makeMemory({
        topic: 'deepone/client_feedback',
        summary: 'Client feedback is ready for handoff.',
      }),
      [{ id: 'entity_room_dm', label: '参加者', kind: 'project' }]
    );

    expect(result.kind).toBe('canonical');
    if (result.kind !== 'canonical') {
      throw new Error('Expected canonical read identity');
    }
    expect(result.displaySubject).toBe('deepone');
    expect(result.displayTopic).toBe('deepone / client feedback');
  });

  it('uses the associated project label as display topic when the legacy topic is low-signal', () => {
    const result = resolveReadIdentity(
      makeMemory({
        topic: '__sd/spine_',
        summary: 'Worker C submitted the SD motion data.',
      }),
      [
        { id: 'entity_person_worker_c', label: 'Worker C', kind: 'person' },
        { id: 'entity_project_room', label: 'Client X animation handoff room', kind: 'project' },
      ]
    );

    expect(result.kind).toBe('canonical');
    if (result.kind !== 'canonical') {
      throw new Error('Expected canonical read identity');
    }
    expect(result.displaySubject).toBe('Client X animation handoff room');
    expect(result.displayTopic).toBe('Client X animation handoff room');
    expect(result.displaySuffix).toBeNull();
  });

  it('keeps project-like room labels as the display subject instead of collapsing to legacy namespace', () => {
    const result = resolveReadIdentity(
      makeMemory({
        topic: '142301__ex_/_',
        summary:
          'Worker A submitted the EX skill motion data (Google Drive). Reviewer B consolidated the packaging image from two files to one and cleared the handoff.',
      }),
      [
        { id: 'entity_person_reviewer', label: 'Reviewer B', kind: 'person' },
        { id: 'entity_person_worker', label: 'Worker A', kind: 'person' },
        { id: 'entity_room_consult', label: 'Project Discussion Room', kind: 'project' },
      ]
    );

    expect(result.kind).toBe('canonical');
    if (result.kind !== 'canonical') {
      throw new Error('Expected canonical read identity');
    }
    expect(result.displaySubject).toBe('Project Discussion Room');
    expect(result.displayTopic).toBe('Project Discussion Room');
    expect(result.displaySuffix).toBeNull();
  });

  it('loads canonical entity bindings for decision ids from one bulk lookup', async () => {
    await createEntityNode({
      id: 'entity_project_alpha',
      kind: 'project',
      preferred_label: 'Project Alpha',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'alpha',
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
      related_surface_forms: ['Project Alpha'],
      timestamp_observed: 1_710_000_000_000,
      scope_kind: 'project',
      scope_id: 'alpha',
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '/tmp/slack.db',
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

    const saved = await saveMemory({
      topic: 'project_alpha/status',
      kind: 'decision',
      summary: 'Project Alpha kickoff approved',
      details: 'Project Alpha kickoff approved',
      scopes: [{ kind: 'project', id: 'alpha' }],
      source: { package: 'mama-core', source_type: 'test' },
      entityObservationIds: ['obs_project_alpha'],
    });

    expect(saved.success).toBe(true);

    const bindings = await loadDecisionReadIdentityIndex([saved.id, 'decision_without_binding']);

    expect(bindings.get(saved.id)).toEqual([
      { id: 'entity_project_alpha', label: 'Project Alpha', kind: 'project' },
    ]);
    expect(bindings.get('decision_without_binding')).toBeUndefined();
  });
});
