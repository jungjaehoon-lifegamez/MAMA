import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { beginModelRunInAdapter, getModelRunInAdapter } from '../../../mama-core/src/index.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

import {
  SUBAGENT_BOOT_FAILURE_REASON,
  failOrphanedSubagentModelRuns,
} from '../../src/agent/subagent-run-reconcile.js';

describe('subagent model run boot reconciliation', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('subagent-run-reconcile');
  });

  beforeEach(() => {
    getAdapter().prepare('DELETE FROM model_runs').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('fails open child runs a dead process left behind and leaves other runs alone', () => {
    const adapter = getAdapter();
    const child = beginModelRunInAdapter(adapter, {
      input_refs: { sourceMessageRef: 'subagent:child-1', entrypoint: 'agent_loop' },
    });
    const ownerTurn = beginModelRunInAdapter(adapter, {
      input_refs: { sourceMessageRef: 'owner-stimulus:cron:1', entrypoint: 'agent_loop' },
    });
    const unrefed = beginModelRunInAdapter(adapter, {});

    expect(failOrphanedSubagentModelRuns(adapter)).toBe(1);

    expect(getModelRunInAdapter(adapter, child.model_run_id)).toMatchObject({
      status: 'failed',
      error_summary: SUBAGENT_BOOT_FAILURE_REASON,
    });
    expect(getModelRunInAdapter(adapter, ownerTurn.model_run_id)).toMatchObject({
      status: 'running',
    });
    expect(getModelRunInAdapter(adapter, unrefed.model_run_id)).toMatchObject({
      status: 'running',
    });
  });

  it('reports nothing to reconcile on a clean boot', () => {
    expect(failOrphanedSubagentModelRuns(getAdapter())).toBe(0);
  });
});
