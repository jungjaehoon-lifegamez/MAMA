import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { saveMemory, recallMemory, buildProfile, ingestMemory } from '../../src/memory/api.js';
import { projectMemoryTruth } from '../../src/memory/truth-store.js';
import {
  appendEntityTimelineEvent,
  createEntityNode,
  upsertEntityObservation,
} from '../../src/entities/store.js';
import { appendEntityLineageLink } from '../../src/entities/lineage-store.js';
import { getAdapter } from '../../src/db-manager.js';

const TEST_DB = '/tmp/test-memory-v2-api.db';

describe('memory v2 api', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;

    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should save and recall a scoped memory', async () => {
    const saved = await saveMemory({
      topic: 'test_scope_contract',
      kind: 'decision',
      summary: 'Use pnpm in this repo',
      details: 'Repo standard',
      confidence: 0.9,
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
    });

    const recall = await recallMemory('pnpm', {
      scopes: [{ kind: 'project', id: 'repo:test' }],
      includeProfile: true,
    });

    expect(saved.success).toBe(true);
    expect(recall.memories.some((item) => item.topic === 'test_scope_contract')).toBe(true);
    expect(recall.profile).toBeDefined();
  });

  it('should build a profile snapshot', async () => {
    const profile = await buildProfile([{ kind: 'project', id: 'repo:test' }]);

    expect(profile).toHaveProperty('static');
    expect(profile).toHaveProperty('dynamic');
    expect(profile).toHaveProperty('evidence');
  });

  it('should preserve event datetime and order recall by event datetime before created_at', async () => {
    await saveMemory({
      topic: 'test_time_contract_older',
      kind: 'decision',
      summary: 'Older event happened first',
      details: 'Older by event datetime',
      confidence: 0.7,
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
      eventDate: '2026-04-14',
      eventDateTime: Date.parse('2026-04-14T01:00:00.000Z'),
    } as never);

    await saveMemory({
      topic: 'test_time_contract_newer',
      kind: 'decision',
      summary: 'Newer event happened later',
      details: 'Newer by event datetime',
      confidence: 0.7,
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
      eventDate: '2026-04-15',
      eventDateTime: Date.parse('2026-04-15T03:30:00.000Z'),
    } as never);

    const recall = await recallMemory('event happened', {
      scopes: [{ kind: 'project', id: 'repo:test' }],
    });

    const newer = recall.memories.find((item) => item.topic === 'test_time_contract_newer');
    const older = recall.memories.find((item) => item.topic === 'test_time_contract_older');

    expect(newer?.event_date).toBe('2026-04-15');
    expect(newer?.event_datetime).toBe(Date.parse('2026-04-15T03:30:00.000Z'));
    expect(older?.event_datetime).toBe(Date.parse('2026-04-14T01:00:00.000Z'));
    expect(
      recall.memories.findIndex((item) => item.topic === 'test_time_contract_newer')
    ).toBeLessThan(recall.memories.findIndex((item) => item.topic === 'test_time_contract_older'));
  });

  it('should forward eventDateTime through ingestMemory', async () => {
    const saved = await ingestMemory({
      content: 'Ingested memory with event datetime',
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
      eventDate: '2026-04-16',
      eventDateTime: Date.parse('2026-04-16T08:45:00.000Z'),
    });

    const row = getAdapter()
      .prepare('SELECT event_date, event_datetime FROM decisions WHERE id = ?')
      .get(saved.id) as { event_date: string | null; event_datetime: number | null } | undefined;

    expect(row).toEqual({
      event_date: '2026-04-16',
      event_datetime: Date.parse('2026-04-16T08:45:00.000Z'),
    });
  });

  it('should persist connector timeline events inside saveMemory', async () => {
    await createEntityNode({
      id: 'entity_project_timeline_contract',
      kind: 'project',
      preferred_label: 'Timeline Contract',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'repo:test',
      merged_into: null,
    });

    const saved = await saveMemory({
      topic: 'timeline_contract/kickoff',
      kind: 'decision',
      summary: 'Kickoff moved forward',
      details: 'Connector-originated timeline change',
      confidence: 0.8,
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
      timelineEvent: {
        entity_id: 'entity_project_timeline_contract',
        event_type: 'project_update',
        role: 'implementer',
        observed_at: Date.parse('2026-04-15T10:00:00.000Z'),
        source_ref: '/tmp/test/raw.db',
        summary: 'Kickoff moved forward',
        details: JSON.stringify({ topic: 'timeline_contract/kickoff' }),
      },
    });

    const row = getAdapter()
      .prepare(
        `
          SELECT entity_id, event_type, role, source_ref, summary
          FROM entity_timeline_events
          WHERE entity_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get('entity_project_timeline_contract') as
      | {
          entity_id: string;
          event_type: string;
          role: string | null;
          source_ref: string | null;
          summary: string;
        }
      | undefined;

    expect(saved.success).toBe(true);
    expect(row).toEqual({
      entity_id: 'entity_project_timeline_contract',
      event_type: 'project_update',
      role: 'implementer',
      source_ref: '/tmp/test/raw.db',
      summary: 'Kickoff moved forward',
    });
  });

  it('should derive the timeline target entity from observation lineage when entity_id is omitted', async () => {
    await createEntityNode({
      id: 'entity_project_timeline_derived',
      kind: 'project',
      preferred_label: 'Derived Timeline Project',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'repo:test',
      merged_into: null,
    });
    await createEntityNode({
      id: 'entity_person_timeline_derived',
      kind: 'person',
      preferred_label: 'Timeline Owner',
      status: 'active',
      scope_kind: 'global',
      scope_id: null,
      merged_into: null,
    });

    await upsertEntityObservation({
      id: 'obs_timeline_derived_channel',
      observation_type: 'channel',
      entity_kind_hint: 'project',
      surface_form: 'Derived Timeline Project',
      normalized_form: 'derived timeline project',
      lang: 'en',
      script: 'Latn',
      context_summary: 'Project context',
      related_surface_forms: ['Timeline Owner'],
      timestamp_observed: Date.parse('2026-04-15T12:00:00.000Z'),
      scope_kind: 'project',
      scope_id: 'repo:test',
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '/tmp/test/raw.db',
      source_raw_record_id: 'raw_timeline_derived_channel',
    });
    await upsertEntityObservation({
      id: 'obs_timeline_derived_author',
      observation_type: 'author',
      entity_kind_hint: 'person',
      surface_form: 'Timeline Owner',
      normalized_form: 'timeline owner',
      lang: 'en',
      script: 'Latn',
      context_summary: 'Author context',
      related_surface_forms: ['Derived Timeline Project'],
      timestamp_observed: Date.parse('2026-04-15T12:00:00.000Z'),
      scope_kind: 'global',
      scope_id: null,
      extractor_version: 'history-extractor@v1',
      embedding_model_version: 'multilingual-e5-large',
      source_connector: 'slack',
      source_locator: '/tmp/test/raw.db',
      source_raw_record_id: 'raw_timeline_derived_author',
    });
    await appendEntityLineageLink({
      canonical_entity_id: 'entity_project_timeline_derived',
      entity_observation_id: 'obs_timeline_derived_channel',
      source_entity_id: null,
      contribution_kind: 'seed',
      run_id: null,
      candidate_id: null,
      review_action_id: null,
      capture_mode: 'direct',
      confidence: 1,
    });
    await appendEntityLineageLink({
      canonical_entity_id: 'entity_person_timeline_derived',
      entity_observation_id: 'obs_timeline_derived_author',
      source_entity_id: null,
      contribution_kind: 'seed',
      run_id: null,
      candidate_id: null,
      review_action_id: null,
      capture_mode: 'direct',
      confidence: 1,
    });

    await saveMemory({
      topic: 'timeline_contract/derived',
      kind: 'decision',
      summary: 'Derived timeline target',
      details: 'Save should pick the project canonical entity from provenance observations',
      confidence: 0.8,
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
      entityObservationIds: ['obs_timeline_derived_author', 'obs_timeline_derived_channel'],
      timelineEvent: {
        event_type: 'project_update',
        observed_at: Date.parse('2026-04-15T12:00:00.000Z'),
        source_ref: '/tmp/test/raw.db',
        summary: 'Derived timeline target',
        details: JSON.stringify({ topic: 'timeline_contract/derived' }),
      },
    });

    const row = getAdapter()
      .prepare(
        `
          SELECT entity_id, event_type
          FROM entity_timeline_events
          WHERE summary = ?
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get('Derived timeline target') as
      | {
          entity_id: string;
          event_type: string;
        }
      | undefined;

    expect(row).toEqual({
      entity_id: 'entity_project_timeline_derived',
      event_type: 'project_update',
    });
  });

  it('should remove the decision row when transactional timeline persistence fails', async () => {
    await createEntityNode({
      id: 'entity_project_timeline_conflict',
      kind: 'project',
      preferred_label: 'Timeline Conflict',
      status: 'active',
      scope_kind: 'project',
      scope_id: 'repo:test',
      merged_into: null,
    });

    await appendEntityTimelineEvent({
      event: {
        id: 'et_duplicate_contract',
        entity_id: 'entity_project_timeline_conflict',
        event_type: 'project_update',
        valid_from: null,
        valid_to: null,
        observed_at: Date.parse('2026-04-15T11:00:00.000Z'),
        source_ref: '/tmp/test/raw.db',
        summary: 'Existing event',
        details: JSON.stringify({ existing: true }),
      },
    });

    await expect(
      saveMemory({
        topic: 'timeline_contract/rollback',
        kind: 'decision',
        summary: 'This save should roll back',
        details: 'Duplicate timeline event id should fail',
        confidence: 0.6,
        scopes: [{ kind: 'project', id: 'repo:test' }],
        source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
        timelineEvent: {
          id: 'et_duplicate_contract',
          entity_id: 'entity_project_timeline_conflict',
          event_type: 'project_update',
          observed_at: Date.parse('2026-04-15T11:05:00.000Z'),
          source_ref: '/tmp/test/raw.db',
          summary: 'Conflicting event',
          details: JSON.stringify({ duplicate: true }),
        },
      })
    ).rejects.toThrow();

    const decisionRow = getAdapter()
      .prepare(`SELECT id FROM decisions WHERE topic = ?`)
      .get('timeline_contract/rollback') as { id: string } | undefined;

    expect(decisionRow).toBeUndefined();
  });

  it('should return truth-gated recall by default', async () => {
    await projectMemoryTruth({
      memory_id: 'decision_quarantined_recall',
      topic: 'prompt_injection',
      truth_status: 'quarantined',
      effective_summary: 'Do not use this',
      effective_details: 'Invalid memory',
      trust_score: 0.1,
      scope_refs: [{ kind: 'project', id: 'repo:test' }],
      supporting_event_ids: ['evt_quarantine'],
    });

    const bundle = await recallMemory('prompt_injection', {
      scopes: [{ kind: 'project', id: 'repo:test' }],
    });

    expect(bundle.memories.every((row) => row.status !== 'quarantined')).toBe(true);
  });
});
