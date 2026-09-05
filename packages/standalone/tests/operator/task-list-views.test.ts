/**
 * Task B — progressive task_list views over a REAL in-memory TaskLedger.
 *
 * Synthetic data only. Covers the accepted corrections: bounded items default,
 * honest totals, full-board reachability through pages, cursor invalidation on a
 * changed query or an intervening write, overview partitions, detail text
 * continuation, the system-row/foreign-id missing contract, and the narrow
 * Temporal work context.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskLedger, type TaskRecord } from '../../src/operator/task-ledger.js';
import { runTaskListView } from '../../src/operator/task-list-views.js';
import Database from '../../src/sqlite.js';

const NOW = Date.parse('2026-07-21T12:00:00Z');
const STATUSES = ['pending', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
const PRIORITIES = ['high', 'normal', 'low'] as const;

function makeLedger(): TaskLedger {
  return new TaskLedger(new Database(':memory:'), { now: () => NOW, timeZone: 'UTC' });
}

/** 371 owner rows with a deterministic spread of status/priority/assignee/due shape. */
function seedBoard(ledger: TaskLedger): void {
  for (let i = 1; i <= 371; i += 1) {
    const shape = i % 3;
    ledger.create({
      title: `task-${i}`,
      status: STATUSES[i % STATUSES.length],
      priority: PRIORITIES[i % PRIORITIES.length],
      assignee: i % 4 === 0 ? 'worker-a' : i % 4 === 1 ? 'worker-b' : undefined,
      source_channel: `slack:C${String(i % 5).padStart(3, '0')}`,
      // Date-only deadline / exact due_at / genuinely undated - three real shapes.
      ...(shape === 0
        ? { deadline: i % 2 === 0 ? '2026-07-10' : '2026-08-10' }
        : shape === 1
          ? { due_at: i % 2 === 0 ? '2026-07-20T09:00:00Z' : '2026-07-25T09:00:00Z' }
          : {}),
    });
  }
}

function items(ledger: TaskLedger, input: Record<string, unknown> = {}) {
  return runTaskListView({ view: 'items', ...input }, { ledger }) as {
    view: 'items';
    tasks: Array<Record<string, unknown>>;
    total: number;
    returned: number;
    nextCursor: string | null;
    readVersion: string;
    observedAt: string;
  };
}

describe('Task B: task_list items view', () => {
  let ledger: TaskLedger;
  beforeEach(() => {
    ledger = makeLedger();
    seedBoard(ledger);
  });

  it('defaults to a bounded page of 25 with an honest whole-board total', () => {
    const page = items(ledger);
    expect(page.returned).toBe(25);
    expect(page.tasks).toHaveLength(25);
    expect(page.total).toBe(371);
    expect(page.nextCursor).not.toBeNull();
    // The concise row must not leak reason/HTML or the full record shape.
    for (const row of page.tasks) {
      expect(row).not.toHaveProperty('latestEvent');
      expect(row).not.toHaveProperty('temporal_epoch');
      expect(row).not.toHaveProperty('createdAt');
      expect(row).toHaveProperty('temporal_state');
    }
  });

  it('walks every page exactly once and reaches the whole board when nothing writes', () => {
    const seen = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ReturnType<typeof items> = items(ledger, cursor === null ? {} : { cursor });
      pages += 1;
      for (const row of page.tasks) seen.add(row.id as number);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.size).toBe(371);
    expect(pages).toBe(Math.ceil(371 / 25));
  });

  it('rejects a cursor after an intervening write with restart guidance', () => {
    const first = items(ledger);
    ledger.create({ title: 'a new owner row mid-traversal' });
    expect(() => items(ledger, { cursor: first.nextCursor })).toThrow(/restart/i);
  });

  it('rejects a cursor whose query changed', () => {
    const first = items(ledger, { status: 'pending' });
    expect(first.nextCursor).not.toBeNull();
    expect(() => items(ledger, { status: 'in_progress', cursor: first.nextCursor })).toThrow(
      /different query/i
    );
  });

  it('rejects a malformed cursor', () => {
    expect(() => items(ledger, { cursor: 'not-a-cursor' })).toThrow(/malformed/i);
  });

  it('rejects a page size that is not an integer in 1..50, never clamps', () => {
    expect(() => items(ledger, { limit: 0 })).toThrow(/1 to 50/);
    expect(() => items(ledger, { limit: 51 })).toThrow(/1 to 50/);
    expect(() => items(ledger, { limit: 1.5 })).toThrow(/1 to 50/);
    expect(items(ledger, { limit: 50 }).returned).toBe(50);
  });

  it('honours include_terminal:false with an honest reduced total', () => {
    const all = items(ledger).total;
    const open = items(ledger, { include_terminal: false }).total;
    expect(open).toBeLessThan(all);
    // done+cancelled are 2 of every 5 rows.
    expect(all - open).toBe(
      Array.from({ length: 371 }, (_, k) => k + 1).filter((i) => i % 5 === 3 || i % 5 === 4).length
    );
  });

  it('preserves date-only deadlines and exact due_at separately in a compact row', () => {
    // shape 0 (date-only) at i=6 -> deadline 2026-07-10, no due_at.
    const dateOnly = items(ledger, { search: 'task-6', limit: 50 }).tasks.find(
      (row) => row.title === 'task-6'
    );
    expect(dateOnly).toMatchObject({ deadline: '2026-07-10', due_at: null });
    // shape 1 (exact) at i=4 -> due_at set, deadline is its date component.
    const exact = items(ledger, { search: 'task-4', limit: 50 }).tasks.find(
      (row) => row.title === 'task-4'
    );
    expect(exact).toMatchObject({ due_at: '2026-07-20T09:00:00.000Z', deadline: '2026-07-20' });
  });
});

describe('Task B: task_list overview view', () => {
  let ledger: TaskLedger;
  beforeEach(() => {
    ledger = makeLedger();
    seedBoard(ledger);
  });

  it('every facet partitions the same total the page was drawn from', () => {
    const overview = runTaskListView({ view: 'overview' }, { ledger }) as {
      total: number;
      status: Record<string, number>;
      priority: Record<string, number>;
      channels: Array<{ count: number }>;
      assignees: Array<{ count: number }>;
      due: { missing: number; overdue: number; upcoming: number; closed: number };
      readVersion: string;
    };
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    expect(overview.total).toBe(371);
    expect(sum(Object.values(overview.status))).toBe(371);
    expect(sum(Object.values(overview.priority))).toBe(371);
    expect(sum(overview.channels.map((c) => c.count))).toBe(371);
    expect(sum(overview.assignees.map((a) => a.count))).toBe(371);
    expect(
      overview.due.missing + overview.due.overdue + overview.due.upcoming + overview.due.closed
    ).toBe(371);
  });

  it('shares the readVersion an items page reports for the same board', () => {
    const overview = runTaskListView({ view: 'overview' }, { ledger }) as { readVersion: string };
    expect(overview.readVersion).toBe(items(ledger).readVersion);
  });
});

describe('Task B: task_list detail view', () => {
  let ledger: TaskLedger;
  let longTask: TaskRecord;
  const longReason = 'r'.repeat(2500);
  const longTitle = 'T'.repeat(1500);

  beforeEach(() => {
    ledger = makeLedger();
    longTask = ledger.create({ title: longTitle, latest_event: longReason });
  });

  it('returns full detail with reason and revision and reconstructs a long field by paging', () => {
    const first = runTaskListView({ view: 'detail', ids: [longTask.id] }, { ledger }) as {
      tasks: Array<Record<string, unknown>>;
      missingIds: number[];
    };
    const record = first.tasks[0];
    expect(first.missingIds).toEqual([]);
    expect(record.revision).toBe(longTask.revision);
    const reason = record.latestEvent as {
      total: number;
      nextOffset: number | null;
      value: string;
    };
    expect(reason.total).toBe(2500);
    expect(reason.value).toHaveLength(1000);
    expect(reason.nextOffset).toBe(1000);

    let assembled = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const page = runTaskListView(
        { view: 'detail', ids: [longTask.id], text_offset: offset, text_limit: 2000 },
        { ledger }
      ) as { tasks: Array<Record<string, unknown>> };
      const window = page.tasks[0].latestEvent as {
        value: string;
        nextOffset: number | null;
        complete: boolean;
      };
      assembled += window.value;
      offset = window.nextOffset;
    }
    expect(assembled).toBe(longReason);
  });

  it('reports a system workorder id and a nonexistent id as generic missing, never exposing system rows', () => {
    const system = ledger.enqueueWorkOrder({
      workKind: 'self-check',
      idempotencyKey: 'self-check:2026-07-21',
      input: { scheduledFor: '2026-07-21' },
    });
    const result = runTaskListView({ view: 'detail', ids: [system.id, 999999] }, { ledger }) as {
      tasks: unknown[];
      missingIds: number[];
    };
    expect(result.tasks).toEqual([]);
    expect(result.missingIds.sort((a, b) => a - b)).toEqual(
      [system.id, 999999].sort((a, b) => a - b)
    );
  });

  it('rejects a detail batch outside 1..4 distinct ids, never truncating', () => {
    expect(() => runTaskListView({ view: 'detail', ids: [] }, { ledger })).toThrow(/1 to 4/);
    expect(() => runTaskListView({ view: 'detail', ids: [1, 2, 3, 4, 5] }, { ledger })).toThrow(
      /1 to 4/
    );
    expect(() => runTaskListView({ view: 'detail', ids: [1, 1] }, { ledger })).toThrow(/distinct/);
  });
});

describe('Task B: task_list input rejection', () => {
  const ledger = makeLedger();
  it('rejects an unknown view', () => {
    expect(() => runTaskListView({ view: 'nonsense' }, { ledger })).toThrow(/view must be/);
  });
  it('rejects a due filter that is not a strict RFC 3339 timestamp', () => {
    expect(() => runTaskListView({ due_before: '2026-07-21' }, { ledger })).toThrow(/RFC 3339/);
  });
});

describe('Task B: task_list under a narrow Temporal work context', () => {
  let ledger: TaskLedger;
  let bound: TaskRecord;
  beforeEach(() => {
    ledger = makeLedger();
    bound = ledger.create({ title: 'the one host-bound task', status: 'in_progress' });
    ledger.create({ title: 'an unrelated private owner task' });
    ledger.create({ title: 'another unrelated owner task' });
  });

  it('items and overview see only the bound task', () => {
    const page = runTaskListView({ view: 'items' }, { ledger, boundTask: bound }) as {
      total: number;
      tasks: Array<Record<string, unknown>>;
    };
    expect(page.total).toBe(1);
    expect(page.tasks[0].id).toBe(bound.id);
    const overview = runTaskListView({ view: 'overview' }, { ledger, boundTask: bound }) as {
      total: number;
    };
    expect(overview.total).toBe(1);
  });

  it('resolves the bound id in detail and treats every foreign id as missing', () => {
    const found = runTaskListView(
      { view: 'detail', ids: [bound.id] },
      { ledger, boundTask: bound }
    ) as { tasks: Array<Record<string, unknown>>; missingIds: number[] };
    expect(found.tasks[0].id).toBe(bound.id);
    const foreign = runTaskListView(
      { view: 'detail', ids: [bound.id + 1] },
      { ledger, boundTask: bound }
    ) as { tasks: unknown[]; missingIds: number[] };
    expect(foreign.tasks).toEqual([]);
    expect(foreign.missingIds).toEqual([bound.id + 1]);
  });

  it('a filter never widens the bound scope', () => {
    const mismatch = runTaskListView(
      { view: 'items', status: 'pending' },
      { ledger, boundTask: bound }
    ) as { total: number; returned: number };
    // The bound row is in_progress, so a pending filter narrows it to nothing -
    // it can never surface the other owner rows.
    expect(mismatch.total).toBe(0);
    expect(mismatch.returned).toBe(0);
  });
});
