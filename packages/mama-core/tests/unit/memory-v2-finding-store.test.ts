import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { createAuditFinding, listOpenAuditFindings } from '../../src/memory/finding-store.js';

const TEST_DB = '/tmp/test-memory-v2-finding-store.db';

describe('audit finding store', () => {
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

  it('should persist unresolved findings', async () => {
    await createAuditFinding({
      kind: 'memory_conflict',
      severity: 'high',
      summary: 'conflict found',
      evidence_refs: ['evt_1'],
      affected_memory_ids: ['decision_x'],
      recommended_action: 'consult_memory',
    });

    const findings = await listOpenAuditFindings();
    expect(findings.some((finding) => finding.summary === 'conflict found')).toBe(true);
  });
});
