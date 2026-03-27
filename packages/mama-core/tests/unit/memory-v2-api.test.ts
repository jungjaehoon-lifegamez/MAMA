import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { saveMemory, recallMemory, buildProfile } from '../../src/memory-v2/api.js';
import { projectMemoryTruth } from '../../src/memory-v2/truth-store.js';

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
