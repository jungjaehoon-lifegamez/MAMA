import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger, type TaskRecord } from '../../src/operator/task-ledger.js';
import {
  TemporalReconcileScheduler,
  buildTemporalGenerationKey,
  selectTemporalCandidates,
  startOfTaskDate,
} from '../../src/operator/temporal-reconcile.js';
import { occurrenceKeyForTask } from '../../src/operator/task-temporal.js';

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id'>): TaskRecord {
  return {
    id: overrides.id,
    title: `task-${overrides.id}`,
    status: 'pending',
    priority: 'normal',
    kind: 'owner',
    deadline: null,
    deadlineIso: null,
    assignee: null,
    sourceChannel: null,
    sourceEventId: null,
    latestEvent: null,
    autoCreated: true,
    confirmed: false,
    dueAt: null,
    deadlineOffsetMinutes: null,
    revision: 1,
    temporalEpoch: 1,
    temporalReconciledOccurrenceKey: null,
    lastTemporalCheckedAt: null,
    nextTemporalCheckAt: null,
    lastTemporalAttemptId: null,
    temporalState: 'unscheduled',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('Story A2 Task 5: pure temporal candidate selection', () => {
  const now = Date.parse('2026-07-21T15:00:00Z');

  it('uses the exact equality boundary and ignores one millisecond before due', () => {
    const selected = selectTemporalCandidates(
      [
        task({ id: 1, dueAt: now - 1, deadlineIso: '2026-07-21' }),
        task({ id: 2, dueAt: now, deadlineIso: '2026-07-21' }),
        task({ id: 3, dueAt: now + 1, deadlineIso: '2026-07-22' }),
      ],
      new Set(),
      { now, timeZone: 'Asia/Seoul' }
    );
    expect(selected.map((candidate) => candidate.taskId)).toEqual([1, 2]);
    expect(selected.every((candidate) => candidate.priority === 'high')).toBe(true);
  });

  it('selects a due deferred check instead of the original exact instant', () => {
    const selected = selectTemporalCandidates(
      [
        task({
          id: 1,
          dueAt: now - 60_000,
          deadlineIso: '2026-07-21',
          nextTemporalCheckAt: now,
        }),
        task({
          id: 2,
          dueAt: now - 60_000,
          deadlineIso: '2026-07-21',
          nextTemporalCheckAt: now + 1,
        }),
      ],
      new Set(),
      { now, timeZone: 'UTC' }
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ taskId: 1, checkAt: now, kind: 'exact_or_deferred' });
  });

  it('prioritizes a due date-only deferred check ahead of activation backlog', () => {
    const selected = selectTemporalCandidates(
      [
        task({
          id: 1,
          deadlineIso: '2026-07-21',
          nextTemporalCheckAt: now,
        }),
        task({ id: 2, deadlineIso: '2026-07-19' }),
      ],
      new Set(),
      { now, timeZone: 'UTC' }
    );
    expect(selected).toHaveLength(2);
    expect(selected[0]).toMatchObject({
      taskId: 1,
      checkAt: now,
      kind: 'exact_or_deferred',
      priority: 'high',
    });
    expect(selected[1]).toMatchObject({ taskId: 2, kind: 'date_activation' });
  });

  it('uses captured offsets and the injected IANA zone for date-only boundaries', () => {
    expect(startOfTaskDate('2026-07-22', 540, 'UTC')).toBe(Date.parse('2026-07-21T15:00:00Z'));
    expect(startOfTaskDate('2026-07-22', null, 'Asia/Seoul')).toBe(
      Date.parse('2026-07-21T15:00:00Z')
    );
    const selected = selectTemporalCandidates(
      [
        task({ id: 1, deadlineIso: '2026-07-21', deadlineOffsetMinutes: 540 }),
        task({ id: 2, deadlineIso: '2026-07-22', deadlineOffsetMinutes: 540 }),
        task({ id: 3, deadlineIso: '2026-07-23', deadlineOffsetMinutes: 540 }),
        task({ id: 4, deadlineIso: '2026-07-22', deadlineOffsetMinutes: null }),
      ],
      new Set(),
      { now, timeZone: 'Asia/Seoul', exactLimit: 4, dateLimit: 4 }
    );
    expect(selected.map((candidate) => candidate.taskId)).toEqual([1, 2, 4]);
    expect(selected.every((candidate) => candidate.priority === 'normal')).toBe(true);
  });

  it('resolves DST boundaries and rejects a local date skipped by a zone transition', () => {
    expect(startOfTaskDate('2026-03-08', null, 'America/New_York')).toBe(
      Date.parse('2026-03-08T05:00:00Z')
    );
    expect(startOfTaskDate('2026-11-01', null, 'America/New_York')).toBe(
      Date.parse('2026-11-01T04:00:00Z')
    );
    expect(() => startOfTaskDate('2011-12-30', null, 'Pacific/Apia')).toThrow(/does not exist/);
  });

  it('skips closed, finalized, and any already-owned generation', () => {
    const finalized = task({ id: 2, dueAt: now, deadlineIso: '2026-07-21' });
    finalized.temporalReconciledOccurrenceKey = occurrenceKeyForTask(finalized);
    const owned = task({ id: 3, dueAt: now, deadlineIso: '2026-07-21' });
    const ownedKey = buildTemporalGenerationKey(owned, now);
    const selected = selectTemporalCandidates(
      [task({ id: 1, status: 'done', dueAt: now }), finalized, owned],
      new Set([ownedKey]),
      { now, timeZone: 'UTC' }
    );
    expect(selected).toEqual([]);
  });

  it('orders exact/deferred first with cap four, then one oldest date activation', () => {
    const tasks = [6, 2, 5, 1, 4, 3].map((id) =>
      task({ id, dueAt: now - (10 - id), deadlineIso: '2026-07-21' })
    );
    tasks.push(
      task({ id: 20, deadlineIso: '2026-07-20' }),
      task({ id: 21, deadlineIso: '2026-07-19' })
    );
    const selected = selectTemporalCandidates(tasks, new Set(), {
      now,
      timeZone: 'UTC',
    });
    expect(selected).toHaveLength(5);
    expect(selected.slice(0, 4).map((candidate) => candidate.kind)).toEqual([
      'exact_or_deferred',
      'exact_or_deferred',
      'exact_or_deferred',
      'exact_or_deferred',
    ]);
    expect(selected[4]).toMatchObject({ taskId: 21, kind: 'date_activation' });
  });
});

describe('Story A2 Task 5: scheduler lifecycle and durable deduplication', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  const now = Date.parse('2026-07-21T15:00:00Z');

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => now, timeZone: 'Asia/Seoul' });
  });

  afterEach(() => db.close());

  it('pages temporal candidates by the last seen id instead of rescanning prior rows', () => {
    const first = ledger.create({ title: 'first', deadline: '2026-07-20' });
    const second = ledger.create({ title: 'second', deadline: '2026-07-20' });
    const third = ledger.create({ title: 'third', deadline: '2026-07-20' });

    const pageOne = ledger.listTemporalScanPage({ limit: 2, afterId: 0 } as never);
    const pageTwo = ledger.listTemporalScanPage({
      limit: 2,
      afterId: pageOne.at(-1)?.id ?? 0,
    } as never);

    expect(pageOne.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(pageTwo.map((row) => row.id)).toEqual([third.id]);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM operator_tasks
         INDEXED BY idx_operator_tasks_temporal_scan_id
         WHERE kind = 'owner'
           AND status IN ('pending','in_progress','review','blocked')
           AND id > ?
           AND (due_at IS NOT NULL OR deadline IS NOT NULL OR next_temporal_check_at IS NOT NULL)
         ORDER BY id ASC LIMIT ?`
      )
      .all(0, 200) as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join('\n')).toContain(
      'idx_operator_tasks_temporal_scan_id'
    );
  });

  it('uses the same tick for boot and interval scans and rejects double start', () => {
    ledger.create({ title: 'due exact', due_at: '2026-07-22T00:00:00+09:00' });
    let intervalCallback: (() => void) | null = null;
    const clear = vi.fn();
    const scheduler = new TemporalReconcileScheduler({
      ledger,
      now: () => now,
      timeZone: 'Asia/Seoul',
      setInterval: (callback) => {
        intervalCallback = callback;
        return { synthetic: true } as unknown as NodeJS.Timeout;
      },
      clearInterval: clear,
    });

    expect(scheduler.tick()).toMatchObject({ enqueued: 1 });
    scheduler.start();
    expect(() => scheduler.start()).toThrow(/already started/);
    intervalCallback!();
    expect(scheduler.tick()).toMatchObject({ enqueued: 0 });
    scheduler.stop();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('contains an interval scan failure and keeps the scheduler stoppable', () => {
    let intervalCallback: (() => void) | null = null;
    const clear = vi.fn();
    const log = vi.fn();
    const scheduler = new TemporalReconcileScheduler({
      ledger: {
        listTemporalScanPage: () => {
          throw new Error('synthetic scan failure');
        },
        findTemporalGenerationKeys: () => new Set<string>(),
        countOpenWorkOrders: () => 0,
        enqueueTemporalGeneration: vi.fn(),
      },
      now: () => now,
      timeZone: 'UTC',
      setInterval: (callback) => {
        intervalCallback = callback;
        return { synthetic: true } as unknown as NodeJS.Timeout;
      },
      clearInterval: clear,
      log,
    });

    scheduler.start();
    expect(() => intervalCallback!()).not.toThrow();
    expect(log).toHaveBeenCalledWith('[temporal-reconcile] tick failed: synthetic scan failure');
    scheduler.stop();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('does not enqueue past the ten-open temporal workorder cap', () => {
    const fakeLedger = {
      listTemporalScanPage: () => [task({ id: 1, dueAt: now, deadlineIso: '2026-07-21' })],
      findTemporalGenerationKeys: () => new Set<string>(),
      countOpenWorkOrders: () => 10,
      enqueueTemporalGeneration: vi.fn(),
    };
    const scheduler = new TemporalReconcileScheduler({
      ledger: fakeLedger,
      now: () => now,
      timeZone: 'UTC',
    });
    expect(scheduler.tick()).toEqual({ enqueued: 0, saturated: true });
    expect(fakeLedger.enqueueTemporalGeneration).not.toHaveBeenCalled();
  });

  it('scans beyond two hundred non-candidates before selecting a due task', () => {
    for (let index = 0; index < 200; index += 1) {
      ledger.create({
        title: `closed-${index}`,
        status: 'done',
        deadline: '2026-07-20',
      });
    }
    const due = ledger.create({
      title: 'due after closed prefix',
      due_at: '2026-07-22T00:00:00+09:00',
    });
    const scheduler = new TemporalReconcileScheduler({
      ledger,
      now: () => now,
      timeZone: 'Asia/Seoul',
    });

    expect(scheduler.tick()).toMatchObject({ enqueued: 1 });
    expect(ledger.claimNextWorkOrder()).toMatchObject({ payload: { taskId: due.id } });
  });

  it.each([
    ['', ''],
    [`channel-${'x'.repeat(400)}`, `event-${'y'.repeat(400)}`],
  ])('enqueues tasks with legacy source identifiers without aborting the scan', (source, event) => {
    const due = ledger.create({
      title: 'due with legacy source identifiers',
      due_at: '2026-07-22T00:00:00+09:00',
      source_channel: source,
      source_event_id: event,
    });
    const scheduler = new TemporalReconcileScheduler({
      ledger,
      now: () => now,
      timeZone: 'Asia/Seoul',
    });

    expect(scheduler.tick()).toMatchObject({ enqueued: 1 });
    const claimed = ledger.claimNextWorkOrder();
    expect(claimed).toMatchObject({ payload: { taskId: due.id } });
    expect(ledger.loadTemporalWorkContext(claimed!.id)).toMatchObject({ taskId: due.id });
  });

  it('keeps global temporal priority across scan pages', () => {
    const pages = [
      Array.from({ length: 200 }, (_, index) =>
        task({
          id: index + 1,
          dueAt: now - index,
          deadlineIso: '2026-07-21',
        })
      ),
      [task({ id: 201, dueAt: now - 10_000, deadlineIso: '2026-07-21' })],
    ];
    const enqueued: number[] = [];
    const fakeLedger = {
      listTemporalScanPage: ({ afterId }: { limit: number; afterId: number }) =>
        afterId === 0 ? pages[0] : pages[1],
      findTemporalGenerationKeys: () => new Set<string>(),
      countOpenWorkOrders: () => 0,
      enqueueTemporalGeneration: (input: { taskId: number }) => {
        enqueued.push(input.taskId);
        return {} as never;
      },
    };
    const scheduler = new TemporalReconcileScheduler({
      ledger: fakeLedger,
      now: () => now,
      timeZone: 'UTC',
      exactLimit: 4,
      dateLimit: 1,
    });

    expect(scheduler.tick()).toMatchObject({ enqueued: 4 });
    expect(enqueued).toEqual([201, 200, 199, 198]);
  });
});
