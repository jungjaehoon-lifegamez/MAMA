import { describe, expect, it, vi } from 'vitest';
import Database from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { occurrenceKeyForTask } from '../../src/operator/task-temporal.js';
import { WorkOrderConsumer } from '../../src/operator/workorder-consumer.js';
import {
  closeTemporalRuntimeBeforeDatabase,
  createTemporalRuntime,
  preflightTemporalStartup,
  resolveTemporalReconcileFlag,
} from '../../src/operator/temporal-runtime.js';

function dependencies(overrides: Record<string, unknown> = {}) {
  const order: string[] = [];
  const scheduler = {
    tick: vi.fn(() => {
      order.push('scan');
      return { enqueued: 0, saturated: false };
    }),
    start: vi.fn(() => order.push('timer')),
    stop: vi.fn(() => order.push('scanner-stop')),
  };
  const consumer = {
    bootRecover: vi.fn(() => order.push('recover')),
    stop: vi.fn(async () => void order.push('consumer-stop')),
  };
  const ledger = {
    repairClosedTemporalGenerations: vi.fn(() => {
      order.push('repair');
      return 0;
    }),
    pauseActiveTemporalWork: vi.fn(() => {
      order.push('pause');
      return 0;
    }),
    resumePausedTemporalWork: vi.fn(() => {
      order.push('resume');
      return [];
    }),
  };
  return {
    order,
    scheduler,
    consumer,
    ledger,
    options: {
      env: { MAMA_TEMPORAL_RECONCILE: 'on' },
      stage2Flag: 'on' as const,
      backend: 'codex',
      envelopeIssuanceMode: 'enabled' as const,
      effectiveTools: ['task_temporal_reconcile'],
      availableTools: ['task_temporal_reconcile'],
      transportReady: true,
      timeZone: 'Asia/Seoul',
      ledger,
      consumer,
      registerRole: vi.fn(() => order.push('register')),
      createScheduler: vi.fn(() => scheduler),
      ...overrides,
    },
  };
}

describe('Story A2 Task 10: temporal runtime lifecycle', () => {
  it('defaults to off and rejects unknown values', () => {
    expect(resolveTemporalReconcileFlag({})).toBe('off');
    expect(resolveTemporalReconcileFlag({ MAMA_TEMPORAL_RECONCILE: 'off' })).toBe('off');
    expect(() => resolveTemporalReconcileFlag({ MAMA_TEMPORAL_RECONCILE: 'shadow' })).toThrow(
      /off\|on/
    );
  });

  it('preflights both flags and pauses a Stage-2 mismatch before throwing', () => {
    const pause = vi.fn();
    expect(
      preflightTemporalStartup({
        MAMA_TEMPORAL_RECONCILE: 'on',
        MAMA_STAGE2_WORKORDERS: 'on',
      })
    ).toEqual({ temporalFlag: 'on', stage2Flag: 'on' });
    expect(() =>
      preflightTemporalStartup(
        { MAMA_TEMPORAL_RECONCILE: 'on', MAMA_STAGE2_WORKORDERS: 'shadow' },
        pause
      )
    ).toThrow(/MAMA_STAGE2_WORKORDERS=on/);
    expect(pause).toHaveBeenCalledWith('stage2-shadow');
  });

  it('does not mutate durable work when either startup flag is malformed', () => {
    const pause = vi.fn();
    expect(() => preflightTemporalStartup({ MAMA_STAGE2_WORKORDERS: 'broken' }, pause)).toThrow(
      /MAMA_STAGE2_WORKORDERS/
    );
    expect(() => preflightTemporalStartup({ MAMA_TEMPORAL_RECONCILE: 'broken' }, pause)).toThrow(
      /MAMA_TEMPORAL_RECONCILE/
    );
    expect(pause).not.toHaveBeenCalled();
  });

  it('off registers no role or scheduler and pauses before returning from boot', () => {
    const ctx = dependencies({ env: {} });
    const runtime = createTemporalRuntime(ctx.options);
    expect(ctx.options.registerRole).not.toHaveBeenCalled();
    expect(ctx.options.createScheduler).not.toHaveBeenCalled();
    expect(runtime.boot()).toEqual({ enabled: false, paused: 0, resumed: 0, enqueued: 0 });
    expect(ctx.order).toEqual(['repair', 'pause']);
  });

  it.each(['off', 'shadow'] as const)(
    'pauses and rejects on with Stage-2 %s before constructing a scheduler',
    (stage2Flag) => {
      const ctx = dependencies({ stage2Flag });
      const runtime = createTemporalRuntime(ctx.options);
      expect(() => runtime.boot()).toThrow(/MAMA_STAGE2_WORKORDERS=on/);
      expect(ctx.order).toEqual(['repair', 'pause']);
      expect(ctx.options.registerRole).not.toHaveBeenCalled();
      expect(ctx.options.createScheduler).not.toHaveBeenCalled();
    }
  );

  it('rejects an incompatible backend or missing trusted tool before any timer exists', () => {
    const backend = dependencies({ backend: 'legacy' });
    expect(() => createTemporalRuntime(backend.options)).toThrow(/backend/);
    expect(backend.options.createScheduler).not.toHaveBeenCalled();
    const tool = dependencies({ effectiveTools: [] });
    expect(() => createTemporalRuntime(tool.options)).toThrow(/task_temporal_reconcile/);
    expect(tool.options.createScheduler).not.toHaveBeenCalled();
    const unavailable = dependencies({ availableTools: [] });
    expect(() => createTemporalRuntime(unavailable.options)).toThrow(/transport.*tool/i);
    expect(unavailable.options.createScheduler).not.toHaveBeenCalled();
    const transport = dependencies({ transportReady: false });
    expect(() => createTemporalRuntime(transport.options)).toThrow(/worker transport/i);
    expect(transport.options.createScheduler).not.toHaveBeenCalled();
  });

  it('rejects disabled envelope issuance before registering the temporal role', () => {
    const ctx = dependencies({ envelopeIssuanceMode: 'off' });

    expect(() => createTemporalRuntime(ctx.options)).toThrow(/envelope issuance/i);
    expect(ctx.options.registerRole).not.toHaveBeenCalled();
    expect(ctx.options.createScheduler).not.toHaveBeenCalled();
  });

  it('resumes, recovers, boot-scans, and starts exactly one interval in order', () => {
    const ctx = dependencies();
    const runtime = createTemporalRuntime(ctx.options);
    expect(ctx.order).toEqual(['register']);

    expect(runtime.boot()).toEqual({ enabled: true, paused: 0, resumed: 0, enqueued: 0 });
    expect(ctx.order).toEqual(['register', 'repair', 'resume', 'recover', 'scan', 'timer']);
    expect(() => runtime.boot()).toThrow(/already booted/);
    expect(ctx.scheduler.start).toHaveBeenCalledOnce();
  });

  it('stops new admission and durably pauses before awaiting consumer drainage', async () => {
    const ctx = dependencies();
    const runtime = createTemporalRuntime(ctx.options);
    runtime.boot();
    await runtime.stop();
    expect(ctx.order.slice(-3)).toEqual(['scanner-stop', 'consumer-stop', 'pause']);
    expect(ctx.ledger.pauseActiveTemporalWork).toHaveBeenLastCalledWith('temporal-runtime-stopped');
  });

  it('persists the pause while an in-flight consumer is still draining', async () => {
    let finishDrain: (() => void) | undefined;
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const consumerStop = vi.fn(() => drain);
    const ctx = dependencies({
      consumer: {
        bootRecover: vi.fn(),
        stop: consumerStop,
      },
    });
    const runtime = createTemporalRuntime(ctx.options);
    runtime.boot();

    const stopping = runtime.stop();
    await Promise.resolve();

    expect(ctx.ledger.pauseActiveTemporalWork).toHaveBeenCalledWith('temporal-runtime-stopped');
    expect(consumerStop).toHaveBeenCalledOnce();
    finishDrain?.();
    await stopping;
  });

  it('awaits runtime shutdown before closing the operator database', async () => {
    const order: string[] = [];
    await closeTemporalRuntimeBeforeDatabase(
      { enabled: true, boot: vi.fn(), stop: vi.fn(async () => void order.push('runtime-stop')) },
      null,
      () => void order.push('db-close')
    );
    expect(order).toEqual(['runtime-stop', 'db-close']);
  });
});

describe('Story A2 Task 10: temporal restart integration', () => {
  function harness() {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const runs: number[] = [];
    const consumer = new WorkOrderConsumer({
      ledger,
      runner: {
        runWithContent: async (_content, options) => {
          runs.push(Number(options?.workorderAttemptId ?? -1));
          return { response: 'unexpected model run' };
        },
      },
      loadBrief: () => 'Reconcile temporal work.',
      noticeOwner: () => {},
      opsAlarm: { configured: false, send: async () => {} },
      log: () => {},
    });
    const task = ledger.create({
      title: 'Elapsed meeting',
      due_at: '2026-07-21T14:00:00+09:00',
      source_channel: 'trello:board-148',
      source_event_id: 'card-131',
    });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`;
    const created = ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
    });
    const create = (
      flag: 'off' | 'on',
      stage2Flag: 'off' | 'shadow' | 'on' = 'on',
      order: string[] = []
    ) =>
      createTemporalRuntime({
        env: { MAMA_TEMPORAL_RECONCILE: flag },
        stage2Flag,
        backend: 'codex',
        envelopeIssuanceMode: 'enabled',
        effectiveTools: ['task_temporal_reconcile'],
        availableTools: ['task_temporal_reconcile'],
        transportReady: true,
        timeZone: 'Asia/Seoul',
        ledger,
        consumer,
        registerRole: () => void order.push('register'),
        createScheduler: () => ({
          tick: () => {
            order.push('scan');
            return { enqueued: 0, saturated: false };
          },
          start: () => void order.push('timer'),
          stop: () => void order.push('scanner-stop'),
        }),
      });
    return { db, ledger, consumer, runs, created, generationKey, create };
  }

  it.each(['off', 'shadow'] as const)(
    'on -> Stage-2 %s pauses a stale claim before recovery and does not execute it',
    async (stage2Flag) => {
      const ctx = harness();
      try {
        const enabledRuntime = ctx.create('on');
        expect(enabledRuntime.boot().enabled).toBe(true);
        expect(ctx.ledger.claimNextWorkOrder()?.id).toBe(ctx.created.workOrder.id);
        const runtime = ctx.create('on', stage2Flag);
        expect(() => runtime.boot()).toThrow(/MAMA_STAGE2_WORKORDERS=on/);
        ctx.consumer.bootRecover();
        await ctx.consumer.tick();

        expect(ctx.runs).toEqual([]);
        expect(ctx.ledger.countOpenWorkOrders('temporal')).toBe(0);
        expect(ctx.ledger.inspectTemporalAttempt(ctx.created.workOrder.id)).toMatchObject({
          workOrder: { status: 'cancelled' },
          generation: { disposition: 'active' },
        });
      } finally {
        ctx.db.close();
      }
    }
  );

  it('off -> on resumes exactly one paused row without spending an attempt', () => {
    const ctx = harness();
    try {
      expect(ctx.create('off').boot().paused).toBe(1);
      const order: string[] = [];
      expect(ctx.create('on', 'on', order).boot()).toMatchObject({ enabled: true, resumed: 1 });
      expect(order).toEqual(['register', 'scan', 'timer']);
      expect(ctx.ledger.countOpenWorkOrders('temporal')).toBe(1);
      expect(ctx.ledger.getTemporalGeneration(ctx.generationKey)?.lastWorkOrderId).not.toBe(
        ctx.created.workOrder.id
      );
      expect(ctx.ledger.claimNextWorkOrder()?.payload.attempts).toBe(1);
    } finally {
      ctx.db.close();
    }
  });

  it('repairs a legacy closed owner before paused temporal work can resume', () => {
    const ctx = harness();
    try {
      expect(ctx.create('off').boot().paused).toBe(1);
      ctx.db
        .prepare(`UPDATE operator_tasks SET status = 'done' WHERE id = ?`)
        .run(ctx.created.generation.taskId);

      expect(ctx.create('on').boot()).toMatchObject({ enabled: true, resumed: 0 });
      expect(ctx.ledger.getTemporalGeneration(ctx.generationKey)).toMatchObject({
        disposition: 'superseded',
      });
      expect(ctx.ledger.countOpenWorkOrders('temporal')).toBe(0);
      expect(ctx.runs).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  it('enabled boot applies normal stale-claim retry before scanning', () => {
    const ctx = harness();
    try {
      expect(ctx.ledger.claimNextWorkOrder()?.id).toBe(ctx.created.workOrder.id);
      const order: string[] = [];
      ctx.create('on', 'on', order).boot();

      expect(order).toEqual(['register', 'scan', 'timer']);
      expect(ctx.ledger.inspectTemporalAttempt(ctx.created.workOrder.id).workOrder.status).toBe(
        'failed'
      );
      const replacementId = ctx.ledger.getTemporalGeneration(ctx.generationKey)?.lastWorkOrderId;
      expect(replacementId).not.toBe(ctx.created.workOrder.id);
      expect(ctx.ledger.claimNextWorkOrder()).toMatchObject({
        id: replacementId,
        payload: { attempts: 2 },
      });
    } finally {
      ctx.db.close();
    }
  });
});
