import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import type { TemporalWorkContext } from '../../src/operator/temporal-effect.js';
import { occurrenceKeyForTask, temporalGenerationKey } from '../../src/operator/task-temporal.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';

describe('Story A2 Task 7: trusted temporal work context', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  let executor: GatewayToolExecutor;
  let context: TemporalWorkContext;
  let executionContext: GatewayToolExecutionContext;
  let taskId: number;
  const now = Date.parse('2026-07-21T15:00:00Z');

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => now, timeZone: 'Asia/Seoul' });
    executor = new GatewayToolExecutor();
    executor.setTaskLedger(ledger);
    const task = ledger.create({
      title: 'temporal authority test',
      due_at: '2026-07-22T00:00:00+09:00',
      source_channel: 'trello:synthetic-board',
      source_event_id: 'synthetic-card',
    });
    taskId = task.id;
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = temporalGenerationKey(task.id, occurrenceKey, now);
    ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: now,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
      priority: 'high',
    });
    const attempt = ledger.claimNextWorkOrder()!;
    context = ledger.loadTemporalWorkContext(attempt.id);
    executionContext = {
      executionSurface: 'model_tool',
      temporalWorkContext: context,
      agentContext: {
        source: 'operator',
        platform: 'cli',
        roleName: 'workorder-temporal',
        role: {
          allowedTools: ['code_act', 'report_publish', 'task_list', 'task_temporal_reconcile'],
          allowedPaths: [],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: {
          sessionId: 'operator:worker:temporal',
          channelId: 'worker:temporal',
          startedAt: new Date(now),
        },
        capabilities: ['code_act', 'report_publish', 'task_list', 'task_temporal_reconcile'],
        limitations: [],
        tier: 2,
        backend: 'codex',
      },
    };
  });

  afterEach(() => db.close());

  it('copies only a host-supplied temporal context into an agent run', () => {
    const trusted = buildAgentToolExecutionContext({ temporalWorkContext: context });
    const ordinary = buildAgentToolExecutionContext({ source: 'telegram', channelId: 'tg:1' });

    expect(trusted?.temporalWorkContext).toEqual(context);
    expect(ordinary).not.toHaveProperty('temporalWorkContext');
  });

  it('scopes task_list to the single host-bound owner task', async () => {
    ledger.create({ title: 'unrelated private owner task' });

    const result = (await executor.execute('task_list', {} as never, executionContext)) as {
      success: boolean;
      tasks: Array<{ id: number; title: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe(taskId);
    expect(result.tasks[0]?.title).toBe('temporal authority test');
  });

  it('keeps task_temporal_reconcile unavailable without trusted context', async () => {
    await expect(
      executor.execute('task_temporal_reconcile', {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'model supplied identifiers are not authority',
        task_id: context.taskId,
        attempt_id: context.attemptId,
      } as never)
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
    expect(ledger.getById(taskId)?.revision).toBe(1);
  });

  it('rejects model attempts to override trusted identity fields', async () => {
    await expect(
      executor.execute(
        'task_temporal_reconcile',
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'done',
          reason: 'forged task id',
          task_id: context.taskId + 1,
        } as never,
        executionContext
      )
    ).rejects.toThrow(/unknown|forbidden/);
    expect(ledger.getById(taskId)?.revision).toBe(1);
  });

  it('commits through direct gateway execution and returns the bounded receipt', async () => {
    const result = (await executor.execute(
      'task_temporal_reconcile',
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'Fresh source evidence confirms completion',
      } as never,
      executionContext
    )) as { success: boolean; receipt: { taskId: number; workorderAttemptId: number } };

    expect(result).toMatchObject({
      success: true,
      receipt: { taskId, workorderAttemptId: context.attemptId },
    });
    expect(ledger.getById(taskId)).toMatchObject({ status: 'done', revision: 2 });
  });

  it('retains the exact trusted context through nested Code-Act', async () => {
    const result = await executor.execute(
      'code_act',
      {
        code: `task_temporal_reconcile({ expected_revision: ${context.revision}, outcome: 'resolved', status: 'done', reason: 'Nested host context is exact' })`,
        allowedTools: ['task_temporal_reconcile'],
      },
      executionContext
    );

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(ledger.getTemporalEffect(context.attemptId)).toMatchObject({
      taskId,
      outcome: 'resolved',
    });
  });

  it('allows reads but rejects all temporal writes after supersession', async () => {
    ledger.update(taskId, { due_at: '2026-07-23T00:00:00+09:00' });
    const published: unknown[] = [];
    executor.setReportPublisher((slots) => published.push(slots));

    const read = await executor.execute('task_list', {} as never, executionContext);
    expect(read.success).toBe(true);
    await expect(
      executor.execute(
        'report_publish',
        { slots: { pipeline: '<p>stale</p>' } } as never,
        executionContext
      )
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
    await expect(
      executor.execute(
        'task_temporal_reconcile',
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'done',
          reason: 'stale attempt',
        } as never,
        executionContext
      )
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
    expect(published).toHaveLength(0);
  });

  it('blocks stale side-effect tools even if a legacy Claude catalog exposes them', async () => {
    ledger.update(taskId, { due_at: '2026-07-23T00:00:00+09:00' });
    const legacyContext: GatewayToolExecutionContext = {
      ...executionContext,
      agentContext: {
        ...executionContext.agentContext!,
        role: {
          ...executionContext.agentContext!.role,
          allowedTools: ['browser_click'],
        },
      },
    };

    await expect(
      executor.execute('browser_click', { selector: '#danger' } as never, legacyContext)
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
  });

  it('restricts temporal report publication to the host-derived pipeline slot', async () => {
    const published: unknown[] = [];
    executor.setReportPublisher((slots) => published.push(slots));

    await expect(
      executor.execute(
        'report_publish',
        { slots: { briefing: '<p>forbidden</p>' } } as never,
        executionContext
      )
    ).rejects.toThrow(/pipeline/);
    await expect(
      executor.execute(
        'report_publish',
        { slots: { pipeline: '<p>ok</p>', custom: '<p>forbidden</p>' } } as never,
        executionContext
      )
    ).rejects.toThrow(/pipeline/);

    const result = await executor.execute(
      'report_publish',
      { slots: { pipeline: '<p>ok</p>' } } as never,
      executionContext
    );
    expect(result.success).toBe(true);
    expect(published).toEqual([{ pipeline: '<p>ok</p>' }]);
  });
});
