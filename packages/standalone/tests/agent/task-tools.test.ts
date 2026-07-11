/**
 * Gateway task-ledger tools (M8 Task 0.2): task_list / task_create / task_update
 * executor cases against a REAL in-memory TaskLedger -- proves the mechanism,
 * not substrings. Synthetic data only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database from '../../src/sqlite.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

function makeExecutor(): { executor: GatewayToolExecutor; ledger: TaskLedger } {
  const executor = new GatewayToolExecutor({
    mamaApi: { save: vi.fn() } as unknown as MAMAApiInterface,
  });
  const ledger = new TaskLedger(new Database(':memory:'));
  executor.setTaskLedger(ledger);
  return { executor, ledger };
}

describe('gateway task ledger tools', () => {
  let executor: GatewayToolExecutor;
  let ledger: TaskLedger;

  beforeEach(() => {
    ({ executor, ledger } = makeExecutor());
  });

  it('fails closed when the ledger is not configured', async () => {
    const bare = new GatewayToolExecutor({
      mamaApi: { save: vi.fn() } as unknown as MAMAApiInterface,
    });
    const result = (await bare.execute('task_list', {})) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('task_create -> task_list round-trip in canonical order', async () => {
    await executor.execute('task_create', { title: 'later', deadline: '2026-09-01' });
    await executor.execute('task_create', {
      title: 'sooner',
      deadline: '2026-07-20',
      priority: 'high',
      assignee: 'worker-a',
      source_channel: 'slack:C001',
    });
    const result = (await executor.execute('task_list', {})) as {
      success: boolean;
      tasks: Array<{ title: string; assignee: string | null }>;
    };
    expect(result.success).toBe(true);
    expect(result.tasks.map((t) => t.title)).toEqual(['sooner', 'later']);
    expect(result.tasks[0]?.assignee).toBe('worker-a');
  });

  it('task_update coerces a string id ("12" pattern) and patches the row', async () => {
    const created = (await executor.execute('task_create', { title: 'x' })) as {
      task: { id: number };
    };
    const result = (await executor.execute('task_update', {
      id: String(created.task.id),
      status: 'in_progress',
      latest_event: 'started today',
    })) as { success: boolean; task: { status: string; latestEvent: string } };
    expect(result.success).toBe(true);
    expect(result.task.status).toBe('in_progress');
    expect(result.task.latestEvent).toBe('started today');
  });

  it('task_update rejects a non-numeric id with a typed error', async () => {
    await expect(executor.execute('task_update', { id: 'abc', status: 'done' })).rejects.toThrow(
      /numeric id/
    );
  });

  it('task_create upserts on duplicate source key through the tool surface', async () => {
    await executor.execute('task_create', {
      title: 'review still',
      source_channel: 'slack:C001',
      source_event_id: 'ev-9',
    });
    await executor.execute('task_create', {
      title: 'review still v2',
      source_channel: 'slack:C001',
      source_event_id: 'ev-9',
      latest_event: 'resubmitted',
    });
    expect(ledger.list({})).toHaveLength(1);
    expect(ledger.list({})[0]?.latestEvent).toBe('resubmitted');
  });
});
