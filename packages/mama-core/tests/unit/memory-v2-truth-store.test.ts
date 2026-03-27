import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { projectMemoryTruth, queryTruthByTopic } from '../../src/memory-v2/truth-store.js';

const TEST_DB = '/tmp/test-memory-v2-truth-store.db';

describe('memory truth store', () => {
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

  it('should exclude quarantined memories from default truth queries', async () => {
    await projectMemoryTruth({
      memory_id: 'decision_quarantine_1',
      topic: 'prompt_injection',
      truth_status: 'quarantined',
      effective_summary: 'bad memory',
      effective_details: 'bad memory',
      trust_score: 0.1,
      scope_refs: [{ kind: 'project', id: '/repo' }],
      supporting_event_ids: ['evt_1'],
    });

    const rows = await queryTruthByTopic('prompt_injection');
    expect(rows).toHaveLength(0);
  });
});
