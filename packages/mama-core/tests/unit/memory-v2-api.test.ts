import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { saveMemory, recallMemory, buildProfile, ingestMemory } from '../../src/memory/api.js';
import { createEntityNode } from '../../src/entities/store.js';
import { getAdapter, initDB } from '../../src/db-manager.js';

const TEST_DB = '/tmp/test-memory-v2-api.db';

describe('memory v2 api', () => {
  const originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
    // Own the tier rather than inheriting it. `singleFork: true` shares one process across
    // every test file, and this suite used to run on MAMA_FORCE_TIER_3 leaked by a file that
    // set it at module scope and never restored it. When that leak was closed, this suite
    // started loading the real embedding model and timed out at 30s on a cold CI runner
    // while still passing locally against a warm model cache. A test that needs the lexical
    // path has to say so.
    process.env.MAMA_FORCE_TIER_3 = 'true';
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    if (originalForceTier3 === undefined) delete process.env.MAMA_FORCE_TIER_3;
    else process.env.MAMA_FORCE_TIER_3 = originalForceTier3;

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

    // Raw ingest now stores one immutable observation, not a decisions row:
    // the event time lands on source_at / metadata of the observation.
    const row = getAdapter()
      .prepare('SELECT source_at, metadata_json FROM observation_versions WHERE observation_id = ?')
      .get(saved.id) as { source_at: number | null; metadata_json: string } | undefined;

    expect(row?.source_at).toBe(Date.parse('2026-04-16T08:45:00.000Z'));
    expect(JSON.parse(row!.metadata_json)).toMatchObject({
      eventDate: '2026-04-16',
      eventDateTime: Date.parse('2026-04-16T08:45:00.000Z'),
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

  it('should refuse a timeline event that does not name its entity', async () => {
    await initDB();
    const countRows = (table: string) =>
      (getAdapter().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = {
      decisions: countRows('decisions'),
      timelineEvents: countRows('entity_timeline_events'),
      memoryEvents: countRows('memory_events'),
    };

    await expect(
      saveMemory({
        topic: 'timeline_contract/missing_entity',
        kind: 'decision',
        summary: 'Timeline event without a target entity',
        details: 'The host must not pick the entity for the caller',
        confidence: 0.8,
        scopes: [{ kind: 'project', id: 'repo:test' }],
        source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
        timelineEvent: {
          event_type: 'project_update',
          observed_at: Date.parse('2026-04-15T12:00:00.000Z'),
          summary: 'Timeline event without a target entity',
        },
      })
    ).rejects.toMatchObject({
      name: 'RecordIdentityError',
      code: 'missing_entity_id',
      message: expect.stringContaining('entity_id'),
    });

    expect(countRows('decisions')).toBe(before.decisions);
    expect(countRows('entity_timeline_events')).toBe(before.timelineEvents);
    expect(countRows('memory_events')).toBe(before.memoryEvents);
  });

  it('should return status-gated recall by default', async () => {
    await saveMemory({
      topic: 'prompt_injection',
      kind: 'decision',
      summary: 'Do not use this',
      details: 'Invalid memory',
      confidence: 0.1,
      status: 'stale',
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
    });

    const bundle = await recallMemory('prompt_injection', {
      scopes: [{ kind: 'project', id: 'repo:test' }],
    });

    expect(bundle.memories.every((row) => row.status !== 'stale')).toBe(true);
  });
});
