import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModelRunInAdapter } from '../../../mama-core/src/index.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

import {
  bindCodeActParentModelRun,
  failCodeActParentModelRun,
  finalizeCodeActParentModelRun,
} from '../../src/cli/commands/start.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

describe('STORY-B6: Code-Act context_compile parent model_run lineage', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('code-act-parent-model-run');
  });

  beforeEach(() => {
    getAdapter().prepare('DELETE FROM model_runs').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  function makeContext(): GatewayToolExecutionContext {
    const envelope = makeSignedEnvelope();
    return {
      agentId: 'code-act-agent',
      source: 'watch',
      channelId: 'api:code-act',
      envelope,
      executionSurface: 'code_act',
    };
  }

  it('binds a running parent model_run to Code-Act execution contexts', () => {
    const adapter = getAdapter();
    const context = makeContext();

    const bound = bindCodeActParentModelRun(adapter, context, {
      inputSnapshotRef: 'code-act:test',
      inputRefs: { tool: 'code_act', test: true },
    });

    expect(bound.executionContext?.modelRunId).toMatch(/^mr_/);
    expect(getModelRunInAdapter(adapter, bound.modelRunId ?? '')).toMatchObject({
      status: 'running',
      agent_id: context.agentId,
      envelope_hash: context.envelope?.envelope_hash,
      input_snapshot_ref: 'code-act:test',
    });
  });

  it('commits successful Code-Act parent runs and fails unsuccessful ones', () => {
    const adapter = getAdapter();
    const committed = bindCodeActParentModelRun(adapter, makeContext(), {
      inputSnapshotRef: 'code-act:commit',
      inputRefs: { tool: 'code_act', test: 'commit' },
    });
    finalizeCodeActParentModelRun(adapter, committed.modelRunId, {
      success: true,
    });

    expect(getModelRunInAdapter(adapter, committed.modelRunId ?? '')).toMatchObject({
      status: 'committed',
    });

    const failed = bindCodeActParentModelRun(adapter, makeContext(), {
      inputSnapshotRef: 'code-act:fail',
      inputRefs: { tool: 'code_act', test: 'fail' },
    });
    finalizeCodeActParentModelRun(adapter, failed.modelRunId, {
      success: false,
      error: { message: 'script failed' },
    });

    expect(getModelRunInAdapter(adapter, failed.modelRunId ?? '')).toMatchObject({
      status: 'failed',
      error_summary: 'script failed',
    });
  });

  it('fails running parent runs when Code-Act throws before returning a result', () => {
    const adapter = getAdapter();
    const bound = bindCodeActParentModelRun(adapter, makeContext(), {
      inputSnapshotRef: 'code-act:throw',
      inputRefs: { tool: 'code_act', test: 'throw' },
    });

    failCodeActParentModelRun(adapter, bound.modelRunId, new Error('host bridge crashed'));

    expect(getModelRunInAdapter(adapter, bound.modelRunId ?? '')).toMatchObject({
      status: 'failed',
      error_summary: 'host bridge crashed',
    });
  });
});
