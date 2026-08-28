import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter } from '../../src/db-manager.js';
import { saveMemory } from '../../src/memory/api.js';

const TEST_DB = path.join(os.tmpdir(), `test-truth-projection-sync-${randomUUID()}.db`);
const PROJECT_SCOPE = { kind: 'project' as const, id: 'repo:truth-projection-sync' };

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

describe('Task 12: direct save keeps memory_truth evolution in sync', () => {
  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
  });

  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    delete process.env.MAMA_FORCE_TIER_3;
    cleanupDb();
  });

  it('supersedes the prior truth row when a dominant save creates the edge', async () => {
    const first = await saveMemory({
      topic: 'truth_projection_sync',
      kind: 'decision',
      summary: 'Use the first operating rule',
      details: 'Initial decision',
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });
    const replacement = await saveMemory({
      topic: 'truth_projection_sync',
      kind: 'decision',
      summary: 'Use the replacement operating rule',
      details: 'The owner replaced the initial decision',
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });

    expect(
      getAdapter().prepare('SELECT status, superseded_by FROM decisions WHERE id = ?').get(first.id)
    ).toEqual({ status: 'superseded', superseded_by: replacement.id });
    expect(
      getAdapter()
        .prepare('SELECT truth_status, superseded_by FROM memory_truth WHERE memory_id = ?')
        .get(first.id)
    ).toEqual({ truth_status: 'superseded', superseded_by: replacement.id });
  });
});
