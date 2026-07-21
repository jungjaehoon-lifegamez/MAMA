/**
 * Story M8-P0 -- Gateway task-ledger tools: task_list / task_create /
 * task_update executor cases against a REAL in-memory TaskLedger and a REAL
 * GatewayToolExecutor (no internal mocks; the task paths do not use mamaApi).
 * Synthetic data only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database from '../../src/sqlite.js';

function makeExecutor(): { executor: GatewayToolExecutor; ledger: TaskLedger } {
  const executor = new GatewayToolExecutor();
  const ledger = new TaskLedger(new Database(':memory:'), {
    now: () => Date.parse('2026-07-21T15:00:00Z'),
    timeZone: 'Asia/Seoul',
  });
  executor.setTaskLedger(ledger);
  return { executor, ledger };
}

describe('Story M8-P0: native task ledger gateway tools', () => {
  let executor: GatewayToolExecutor;
  let ledger: TaskLedger;

  beforeEach(() => {
    ({ executor, ledger } = makeExecutor());
  });

  describe('Acceptance Criteria: fail-closed wiring', () => {
    it('fails closed when the ledger is not configured', async () => {
      const bare = new GatewayToolExecutor();
      const result = (await bare.execute('task_list', {})) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });
  });

  describe('Acceptance Criteria: create/list round-trip', () => {
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

    it('accepts exact due_at and returns the normalized temporal projection', async () => {
      const created = (await executor.execute('task_create', {
        title: 'exact',
        due_at: '2026-07-22T09:00:00+09:00',
      })) as {
        task: Record<string, unknown>;
      };
      expect(created.task).toMatchObject({
        due_at: '2026-07-22T00:00:00.000Z',
        deadlineIso: '2026-07-22',
        deadline_offset_minutes: 540,
        revision: 1,
        temporal_epoch: 1,
        temporal_state: 'exact_upcoming',
      });

      const listed = (await executor.execute('task_list', {})) as {
        tasks: Array<Record<string, unknown>>;
      };
      expect(listed.tasks[0]).toMatchObject({
        due_at: '2026-07-22T00:00:00.000Z',
        temporal_state: 'exact_upcoming',
      });
    });

    it('rejects offset-free and conflicting exact due inputs through the ledger boundary', async () => {
      await expect(
        executor.execute('task_create', { title: 'bad', due_at: '2026-07-22T09:00:00' })
      ).rejects.toThrow(/explicit offset/);
      await expect(
        executor.execute('task_create', {
          title: 'conflict',
          due_at: '2026-07-22T09:00:00+09:00',
          deadline: '2026-07-23',
        })
      ).rejects.toThrow(/conflict/);
    });
  });

  describe('Acceptance Criteria: update semantics', () => {
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
  });

  describe('Acceptance Criteria: idempotent create', () => {
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

  describe('Acceptance Criteria: contract_no_update note', () => {
    it('records a scoped note and rejects missing fields', async () => {
      const result = (await executor.execute('contract_no_update', {
        reason: 'greeting only',
        scope: 'reconcile:slack:C001',
      })) as { success: boolean; note: { id: number } };
      expect(result.success).toBe(true);
      expect(ledger.maxNoUpdateId('reconcile:slack:C001')).toBe(result.note.id);
      await expect(executor.execute('contract_no_update', { reason: 'x' })).rejects.toThrow(
        /scope/
      );
    });
  });
});
