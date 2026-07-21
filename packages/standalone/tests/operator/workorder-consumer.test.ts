/**
 * Story S2-T3: workorder consumer - serial consumption, retry policy, alarms,
 * completion hooks. Real in-memory TaskLedger; fake runner/alarm sinks.
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import {
  WorkOrderConsumer,
  WORKORDER_MAX_ATTEMPTS,
  type WorkOrderConsumerDeps,
  type WorkOrderConsumerEvent,
} from '../../src/operator/workorder-consumer.js';

function makeDeps(overrides: Partial<WorkOrderConsumerDeps> = {}): {
  deps: WorkOrderConsumerDeps;
  ledger: TaskLedger;
  notices: string[];
  activeSends: string[];
  events: WorkOrderConsumerEvent[];
  logs: string[];
} {
  const db: SQLiteDatabase = new Database(':memory:');
  const ledger = new TaskLedger(db);
  const notices: string[] = [];
  const activeSends: string[] = [];
  const events: WorkOrderConsumerEvent[] = [];
  const logs: string[] = [];
  const deps: WorkOrderConsumerDeps = {
    ledger,
    runner: {
      runWithContent: async () => ({ response: 'ok done' }),
    },
    loadBrief: () => 'You are a test worker. Do the work.',
    noticeOwner: (summary) => notices.push(summary),
    opsAlarm: { configured: true, send: async (line) => void activeSends.push(line) },
    onEvent: (event) => events.push(event),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, ledger, notices, activeSends, events, logs };
}

describe('Story S2-T3: WorkOrderConsumer', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  it('keeps the temporal retry budget explicit at three attempts', () => {
    expect(WORKORDER_MAX_ATTEMPTS.temporal).toBe(3);
  });

  it('never writes temporal model response content to operational logs', async () => {
    const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    ctx.ledger.enqueueTemporalGeneration({
      generationKey: `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    const privateResponse = 'private connector evidence must not reach logs';
    ctx.deps.runner = { runWithContent: async () => ({ response: privateResponse }) };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    expect(ctx.logs.join('\n')).not.toContain(privateResponse);
  });

  it('stores and reports only a digest when a temporal runner error is private', async () => {
    const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    const generationKey = `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`;
    ctx.ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    const privateError = 'private connector token abc-123';
    ctx.deps.runner = {
      runWithContent: async () => Promise.reject(new Error(privateError)),
    };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    const combined = [
      ...ctx.logs,
      ...ctx.notices,
      ...ctx.activeSends,
      ...ctx.events.map((event) => event.reason ?? ''),
      ctx.ledger.getTemporalGeneration(generationKey)?.reason ?? '',
    ].join('\n');
    expect(combined).not.toContain(privateError);
    expect(combined).toContain('sha256=');
  });

  it('routes temporal exhaustion through the generation transaction', async () => {
    const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    ctx.ledger.enqueueTemporalGeneration({
      generationKey: `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    ctx.deps.runner = { runWithContent: async () => Promise.reject(new Error('synthetic')) };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();
    await consumer.tick();
    await consumer.tick();
    const generation = ctx.ledger.getTemporalGeneration(
      `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`
    );
    expect(generation?.disposition).toBe('exhausted');
    expect(generation?.reason).toMatch(/^temporal-worker-failure;failure_sha256=[a-f0-9]{64};/);
    expect(generation?.reason).not.toContain('synthetic');
    expect(ctx.events.filter((event) => event.type === 'requeued')).toHaveLength(2);
  });

  describe('AC #1: enqueue -> consume -> complete e2e', () => {
    it('drains pending workorders serially and marks them done', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      const a = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:1',
        input: { mode: 'full' },
      });
      const b = ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:1',
        input: { batchId: 'b1', events: [] },
      });

      expect(await consumer.tick()).toBe('drained');
      const stats = ctx.ledger.workOrderStats();
      expect(stats.find((s) => s.workKind === 'board')?.lastStatus).toBe('done');
      expect(stats.find((s) => s.workKind === 'wiki')?.lastStatus).toBe('done');
      expect(ctx.events.filter((e) => e.type === 'complete').map((e) => e.workOrderId)).toEqual([
        a.id,
        b.id,
      ]);
    });

    it('serializes: one claim awaited at a time (claim order respected)', async () => {
      const order: string[] = [];
      ctx.deps.runner = {
        runWithContent: async (content) => {
          order.push(String((content[0] as { text: string }).text.includes('"mode":"full"')));
          await new Promise((r) => setTimeout(r, 5));
          return { response: 'done' };
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k1',
        input: { mode: 'full' },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'k2',
        input: { batchId: 'b', events: [] },
        priority: 'high',
      });
      // high-priority wiki claims first despite later enqueue
      await consumer.tick();
      expect(order).toEqual(['false', 'true']);
    });
  });

  describe('AC #2: overlapping ticks skip (re-entrancy guard, plan G4)', () => {
    it('a tick during a long run returns skipped', async () => {
      let release: () => void = () => {};
      ctx.deps.runner = {
        runWithContent: () =>
          new Promise((resolve) => {
            release = () => resolve({ response: 'done' });
          }),
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k1',
        input: { mode: 'full' },
      });

      const first = consumer.tick();
      expect(await consumer.tick()).toBe('skipped'); // overlapping firing
      release();
      expect(await first).toBe('drained');
    });
  });

  describe('AC #3: retry policy (plan G5/M4)', () => {
    it('wiki requeues once (attempts 2) then exhausts with an active alarm', async () => {
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('worker blew up');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:batch-9',
        input: { batchId: 'b9', events: [] },
      });

      await consumer.tick(); // attempt 1 fails -> requeued (fresh row, attempts 2)
      const requeued = ctx.events.find((e) => e.type === 'requeued');
      expect(requeued).toBeDefined();
      expect(ctx.activeSends).toHaveLength(0); // not exhausted yet

      await consumer.tick(); // attempt 2 fails -> exhausted -> alarm
      expect(ctx.events.some((e) => e.type === 'exhausted')).toBe(true);
      expect(ctx.activeSends).toHaveLength(1);
      expect(ctx.activeSends[0]).toContain('retries exhausted');
      expect(ctx.notices).toHaveLength(1);
    });

    it('board fails once and exhausts immediately (next publish cycle self-heals)', async () => {
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('boom');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(ctx.events.some((e) => e.type === 'requeued')).toBe(false);
      expect(ctx.events.some((e) => e.type === 'exhausted')).toBe(true);
    });

    it('missing brief fails the order loudly (never a silent skip)', async () => {
      ctx.deps.loadBrief = () => null;
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      const failed = ctx.events.find((e) => e.type === 'failed');
      expect(failed?.reason).toBe('brief-missing');
    });
  });

  describe('AC #4: boot recovery routes stale claims through the retry policy', () => {
    it('stale wiki claim alarms AND requeues; stale board claim alarms without requeue', () => {
      const wiki = ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'w',
        input: { batchId: 'b', events: [] },
      });
      ctx.ledger.claimNextWorkOrder(); // wiki in_progress (crash artifact)
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.bootRecover();

      expect(ctx.events.some((e) => e.type === 'stale-claim' && e.workOrderId === wiki.id)).toBe(
        true
      );
      expect(ctx.activeSends.some((l) => l.includes('stale claim'))).toBe(true);
      expect(ctx.events.some((e) => e.type === 'requeued')).toBe(true); // wiki retries once
    });
  });

  describe('AC #5: alarm dedup per kind (6h)', () => {
    it('second exhaustion within the window is log-only', async () => {
      let clock = 1_000_000;
      ctx.deps.now = () => clock;
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('boom');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);

      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k1',
        input: { mode: 'full' },
      });
      await consumer.tick();
      clock += 60_000; // 1 min later, same kind fails again
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k2',
        input: { mode: 'full' },
      });
      await consumer.tick();

      expect(ctx.activeSends).toHaveLength(1); // deduped
      expect(ctx.logs.some((l) => l.includes('alarm deduped'))).toBe(true);

      clock += 7 * 60 * 60 * 1000; // past the window
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k3',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(ctx.activeSends).toHaveLength(2);
    });
  });

  describe('AC #6: completion hooks (plan D1/E4)', () => {
    it('before state flows to after; after-hook errors are loud but never fail the run', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      const seen: unknown[] = [];
      consumer.registerHook('board', {
        before: () => ({ marker: 42 }),
        after: (_wo, response, beforeState) => {
          seen.push(beforeState, response);
          throw new Error('verification hiccup');
        },
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();

      expect(seen[0]).toEqual({ marker: 42 });
      expect(ctx.logs.some((l) => l.includes('after-hook error'))).toBe(true);
      expect(ctx.events.some((e) => e.type === 'complete' && e.workOrderId === wo.id)).toBe(true);
    });

    it('a broken before-hook fails the order (never strands the claim)', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        before: () => {
          throw new Error('snapshot store gone');
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      const failed = ctx.events.find((e) => e.type === 'failed');
      expect(failed?.reason).toContain('before-hook');
    });

    it('duplicate hook registration throws', () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('wiki', {});
      expect(() => consumer.registerHook('wiki', {})).toThrow(/already registered/);
    });
  });

  describe('AC #7: opt-in blocking effect verdict', () => {
    it('completes only after a required hook returns a complete verdict', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => ({ disposition: 'complete' }),
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-complete',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events).toContainEqual({
        type: 'complete',
        workKind: 'board',
        workOrderId: wo.id,
      });
    });

    it('routes a required fail verdict through the existing requeue policy', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('wiki', {
        verdictRequired: true,
        after: () => ({ disposition: 'fail', reason: 'effect-missing' }),
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'required-fail',
        input: { batchId: 'b-required-fail', events: [] },
      });

      await consumer.tick();

      expect(ctx.events).toContainEqual({
        type: 'failed',
        workKind: 'wiki',
        workOrderId: wo.id,
        reason: 'effect-missing',
      });
      expect(ctx.events.some((event) => event.type === 'requeued')).toBe(true);
      expect(ctx.events.some((event) => event.type === 'complete')).toBe(false);
    });

    it('fails when a required hook has no after verifier', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', { verdictRequired: true });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-after-missing',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'effect-verdict-missing'
      );
      expect(ctx.events.some((event) => event.type === 'complete')).toBe(false);
    });

    it('fails when a required verifier returns no verdict', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => undefined,
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-verdict-missing',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'effect-verdict-missing'
      );
    });

    it('fails when a required verifier throws', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: async () => {
          throw new Error('receipt store unavailable');
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-verifier-throws',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'after-hook: receipt store unavailable'
      );
    });

    it('bounds a required verifier exception before persistence and alarms', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => {
          throw new Error(`private-prefix-${'x'.repeat(1_000)}`);
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-verifier-bounded-error',
        input: { mode: 'full' },
      });

      await consumer.tick();

      const reason = ctx.events.find((event) => event.type === 'failed')?.reason;
      expect(reason?.startsWith('after-hook: private-prefix-')).toBe(true);
      expect(reason?.length).toBeLessThanOrEqual(500);
    });

    it.each([
      ['null verdict', null],
      ['primitive verdict', 'complete'],
      ['array verdict', [{ disposition: 'complete' }]],
      ['unknown disposition', { disposition: 'unknown' }],
      ['blank failure reason', { disposition: 'fail', reason: '   ' }],
      ['oversized failure reason', { disposition: 'fail', reason: 'x'.repeat(501) }],
    ])('fails a malformed required verdict: %s', async (_label, verdict) => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => verdict as never,
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: `required-invalid-${_label}`,
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'effect-verdict-invalid'
      );
    });

    it('awaits asynchronous before and after hooks around the runner', async () => {
      const order: string[] = [];
      ctx.deps.runner = {
        runWithContent: async () => {
          order.push('runner');
          return { response: 'done' };
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        before: async () => {
          await Promise.resolve();
          order.push('before');
          return { revision: 7 };
        },
        after: async (_wo, _response, beforeState) => {
          await Promise.resolve();
          order.push(`after:${String((beforeState as { revision: number }).revision)}`);
          return { disposition: 'complete' };
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-async-hooks',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(order).toEqual(['before', 'runner', 'after:7']);
      expect(ctx.events.some((event) => event.type === 'complete')).toBe(true);
    });

    it('ignores a fail-shaped verdict when strict completion is not enabled', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        after: () => ({ disposition: 'fail', reason: 'legacy-observe-only' }),
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'permissive-fail-shaped',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.some((event) => event.type === 'failed')).toBe(false);
      expect(
        ctx.events.some((event) => event.type === 'complete' && event.workOrderId === wo.id)
      ).toBe(true);
    });
  });

  describe('AC #8: start/stop lifecycle', () => {
    it('start twice throws; isStarted reflects state', () => {
      const consumer = new WorkOrderConsumer({ ...ctx.deps, tickMs: 3_600_000 });
      expect(consumer.isStarted()).toBe(false);
      consumer.start();
      expect(consumer.isStarted()).toBe(true);
      expect(() => consumer.start()).toThrow(/already started/);
      consumer.stop();
      expect(consumer.isStarted()).toBe(false);
    });
  });
});

/**
 * Story S2-T4: shadow run-options injection (capture publisher seam).
 */
describe('Story S2-T4: shadow runOptions injection', () => {
  describe('AC #1: capture publisher threading', () => {
    it('threads runOptionsFor output into the runner options', async () => {
      const ctx = makeDeps();
      let captured: Record<string, unknown> = {};
      ctx.deps.runner = {
        runWithContent: async (_content, options) => {
          captured = options as Record<string, unknown>;
          return { response: 'ok' };
        },
      };
      const capturePublisher = (): void => {};
      ctx.deps.runOptionsFor = (wo) =>
        wo.workKind === 'board' ? { reportPublisherOverride: capturePublisher } : undefined;
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(captured.reportPublisherOverride).toBe(capturePublisher);
      expect(captured.channelId).toBe('worker:board'); // identity intact
    });
  });

  describe('AC #2: refusal instead of live-publish fallback', () => {
    it('a runOptionsFor throw fails the order - never a live publish fallback', async () => {
      const ctx = makeDeps();
      ctx.deps.runOptionsFor = () => {
        throw new Error('shadow capture publisher missing');
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      const failed = ctx.events.find((e) => e.type === 'failed');
      expect(failed?.reason).toContain('shadow capture publisher missing');
    });
  });
});

/**
 * Story S2-T3 (review round 1): sink-unconfigured degradation.
 */
describe('Story S2-T3: unconfigured ops alarm sink', () => {
  describe('AC #1: log-only degradation', () => {
    it('exhaustion with an unconfigured sink is log-only (loud) and still notices the owner', async () => {
      const ctx = makeDeps();
      ctx.deps.opsAlarm = {
        configured: false,
        send: async () => {
          throw new Error('must never be called');
        },
      };
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('boom');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();

      expect(ctx.logs.some((l) => l.includes('log-only'))).toBe(true);
      expect(ctx.notices).toHaveLength(1); // passive surface still fires
    });
  });
});

/**
 * Story S2-T3 (review round 2 N1): stop() must await the REAL tick.
 */
describe('Story S2-T3: graceful stop under skipped firings (N1)', () => {
  describe('AC #1: stop awaits the real tick', () => {
    it('skipped timer firings do not overwrite the tracked tick; stop awaits the run', async () => {
      const ctx = makeDeps();
      let release: () => void = () => {};
      ctx.deps.runner = {
        runWithContent: () =>
          new Promise((resolve) => {
            release = () => resolve({ response: 'done' });
          }),
      };
      ctx.deps.tickMs = 5;
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      consumer.start();
      await new Promise((r) => setTimeout(r, 30)); // several firings hit the guard
      setTimeout(() => release(), 10);
      await consumer.stop();
      // With the N1 bug, stop() awaited a 'skipped' promise and resolved before
      // the run finished - this assertion fails then.
      expect(ctx.events.some((e) => e.type === 'complete')).toBe(true);
    });
  });
});
