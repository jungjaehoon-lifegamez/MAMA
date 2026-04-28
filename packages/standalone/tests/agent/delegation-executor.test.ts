import { describe, expect, it, vi } from 'vitest';
import { DelegationExecutor } from '../../src/agent/delegation-executor.js';
import type { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import type { DelegationManager } from '../../src/multi-agent/delegation-manager.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(
  options: {
    response?: string;
    sendMessage?: ReturnType<typeof vi.fn>;
    sessionsDb?: SQLiteDatabase;
    allowed?: boolean;
    denialReason?: string;
  } = {}
) {
  const sendMessage = options.sendMessage ?? vi.fn().mockResolvedValue({ response: 'done' });
  if (options.response !== undefined && !options.sendMessage) {
    sendMessage.mockResolvedValue({ response: options.response });
  }
  const getProcess = vi.fn().mockResolvedValue({
    sendMessage,
    getSessionId: vi.fn().mockReturnValue('delegation-session'),
  });
  const stopProcess = vi.fn();
  const isDelegationAllowed = vi.fn().mockReturnValue({
    allowed: options.allowed ?? true,
    reason: options.denialReason ?? 'ok',
  });
  const buildDelegationPrompt = vi.fn(
    (sourceAgentId: string, task: string) => `[${sourceAgentId}] ${task}`
  );
  const getAgentConfig = vi.fn().mockReturnValue({ connectors: [] });

  const executor = new DelegationExecutor({
    agentProcessManager: { getProcess, stopProcess } as unknown as AgentProcessManager,
    delegationManagerRef: {
      isDelegationAllowed,
      buildDelegationPrompt,
      getAgentConfig,
    } as unknown as DelegationManager,
    sessionsDb: options.sessionsDb,
    retryDelayMs: 1,
    resolveManagedAgentId: (id) => id,
    checkViewerOnly: () => null,
  });

  return {
    executor,
    sendMessage,
    getProcess,
    stopProcess,
    isDelegationAllowed,
    buildDelegationPrompt,
  };
}

describe('DelegationExecutor', () => {
  it('runs delegate with conductor/viewer/default routing fallback', async () => {
    const { executor, getProcess, isDelegationAllowed, buildDelegationPrompt } = createHarness();

    const result = await executor.runDelegate(
      { agentId: 'developer', task: 'Implement the patch' },
      { agentId: '', source: '', channelId: '' }
    );

    expect(result).toMatchObject({
      success: true,
      data: expect.objectContaining({ agentId: 'developer', response: 'done' }),
    });
    expect(isDelegationAllowed).toHaveBeenCalledWith('conductor', 'developer');
    expect(getProcess).toHaveBeenCalledWith('viewer', 'default', 'developer');
    expect(buildDelegationPrompt).toHaveBeenCalledWith('conductor', 'Implement the patch');
  });

  it('persists delegate start and completion activity rows when sessions DB is available', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const { executor } = createHarness({ sessionsDb: db, response: 'Task completed' });

    const result = await executor.runDelegate(
      { agentId: 'developer', task: 'Audit routing' },
      { agentId: 'conductor', source: 'discord', channelId: 'channel-1' }
    );

    expect(result.success).toBe(true);
    const rows = db
      .prepare(
        'SELECT type, execution_status, trigger_reason, input_summary, output_summary FROM agent_activity ORDER BY id'
      )
      .all() as Array<{
      type: string;
      execution_status: string | null;
      trigger_reason: string | null;
      input_summary: string | null;
      output_summary: string | null;
    }>;
    expect(rows).toEqual([
      {
        type: 'task_start',
        execution_status: 'started',
        trigger_reason: 'delegate_run',
        input_summary: 'Audit routing',
        output_summary: null,
      },
      {
        type: 'task_complete',
        execution_status: 'completed',
        trigger_reason: 'delegate_run',
        input_summary: 'Audit routing',
        output_summary: 'Task completed',
      },
    ]);
    db.close();
  });

  it('keeps one agent_test in flight per managed agent', async () => {
    const deferred = createDeferred<{ response: string }>();
    const sendMessage = vi.fn().mockReturnValue(deferred.promise);
    const { executor } = createHarness({ sendMessage });

    const first = executor.runAgentTest(
      {
        agent_id: 'qa-monitor',
        test_data: [{ input: 'case-1', expected: 'expected output' }],
      },
      { agentId: 'conductor', source: 'viewer', channelId: 'channel-1' }
    );
    const second = await executor.runAgentTest(
      {
        agent_id: 'qa-monitor',
        test_data: [{ input: 'case-2', expected: 'expected output' }],
      },
      { agentId: 'conductor', source: 'viewer', channelId: 'channel-1' }
    );

    expect(second).toEqual({ success: false, error: 'test_already_running' });

    deferred.resolve({ response: 'expected output' });
    await expect(first).resolves.toMatchObject({
      success: true,
      data: expect.objectContaining({ auto_score: 100 }),
    });
  });

  it('rejects invalid agent_test sample_count before delegation starts', async () => {
    const { executor, getProcess } = createHarness();

    const result = await executor.runAgentTest(
      { agent_id: 'qa-monitor', sample_count: 0, test_data: [{ input: 'case-1' }] },
      { agentId: 'conductor', source: 'viewer', channelId: 'channel-1' }
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid sample_count for 'qa-monitor'"),
    });
    expect(getProcess).not.toHaveBeenCalled();
  });

  it('returns the delegation denial reason without starting a process', async () => {
    const { executor, getProcess } = createHarness({
      allowed: false,
      denialReason: 'developer cannot delegate',
    });

    const result = await executor.runDelegate(
      { agentId: 'reviewer', task: 'Review this' },
      { agentId: 'developer', source: 'discord', channelId: 'channel-1' }
    );

    expect(result).toEqual({
      success: false,
      error: 'Delegation denied: developer cannot delegate',
    });
    expect(getProcess).not.toHaveBeenCalled();
  });
});
