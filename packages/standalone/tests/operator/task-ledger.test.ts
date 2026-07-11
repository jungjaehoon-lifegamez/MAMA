/**
 * Unit tests for TaskLedger (M8 Task 0.1) - the operator-owned native work-item
 * ledger. Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';

describe('TaskLedger', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db);
  });

  it('creates a task with defaults (pending, normal, auto_created, unconfirmed)', () => {
    const t = ledger.create({ title: 'ship the widget' });
    expect(t.id).toBeGreaterThan(0);
    expect(t.status).toBe('pending');
    expect(t.priority).toBe('normal');
    expect(t.autoCreated).toBe(true);
    expect(t.confirmed).toBe(false);
    expect(t.deadline).toBeNull();
  });

  it('rejects invalid status and priority via CHECK', () => {
    expect(() => ledger.create({ title: 'x', status: 'doing' as never })).toThrow();
    expect(() => ledger.create({ title: 'x', priority: 'urgent' as never })).toThrow();
  });

  it('rejects empty titles and malformed deadlines', () => {
    expect(() => ledger.create({ title: '  ' })).toThrow(/title/);
    expect(() => ledger.create({ title: 'x', deadline: 'next friday' })).toThrow(/ISO date/);
    expect(() => ledger.create({ title: 'x', deadline: '2026-13-99' })).toThrow(/ISO date/);
    expect(() => ledger.create({ title: 'x', deadline: '2026-02-30' })).toThrow(/ISO date/);
  });

  it('maps ISO deadline to UTC-midnight epoch ms for the OperatorTask interface', () => {
    const t = ledger.create({ title: 'x', deadline: '2026-07-20' });
    expect(t.deadlineIso).toBe('2026-07-20');
    expect(t.deadline).toBe(Date.parse('2026-07-20T00:00:00Z'));
  });

  it('upserts on duplicate (source_channel, source_event_id) instead of duplicating', () => {
    const first = ledger.create({
      title: 'review the still',
      source_channel: 'slack:C001',
      source_event_id: 'ev-1',
      latest_event: 'submitted v1',
    });
    const second = ledger.create({
      title: 'review the still (retry wording)',
      source_channel: 'slack:C001',
      source_event_id: 'ev-1',
      latest_event: 'submitted v2',
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('review the still'); // original title kept
    expect(second.latestEvent).toBe('submitted v2'); // movement recorded
    expect(ledger.list({ channel: 'slack:C001' })).toHaveLength(1);
  });

  it('same event id on a DIFFERENT channel is a distinct task', () => {
    ledger.create({ title: 'a', source_channel: 'slack:C001', source_event_id: 'ev-1' });
    ledger.create({ title: 'b', source_channel: 'chatwork:123', source_event_id: 'ev-1' });
    expect(ledger.list({})).toHaveLength(2);
  });

  it('update patches fields and bumps updated_at; unknown id throws', () => {
    const t = ledger.create({ title: 'x' });
    const updated = ledger.update(t.id, {
      status: 'in_progress',
      assignee: 'worker-a',
      deadline: '2026-08-01',
      confirmed: true,
    });
    expect(updated.status).toBe('in_progress');
    expect(updated.assignee).toBe('worker-a');
    expect(updated.deadlineIso).toBe('2026-08-01');
    expect(updated.confirmed).toBe(true);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(t.updatedAt);
    expect(() => ledger.update(9999, { status: 'done' })).toThrow(/no task/);
  });

  it('deadline can be cleared with null', () => {
    const t = ledger.create({ title: 'x', deadline: '2026-08-01' });
    const cleared = ledger.update(t.id, { deadline: null });
    expect(cleared.deadlineIso).toBeNull();
    expect(cleared.deadline).toBeNull();
  });

  it('assignee can be cleared with null', () => {
    const t = ledger.create({ title: 'x', assignee: 'worker-a' });
    const cleared = ledger.update(t.id, { assignee: null });
    expect(cleared.assignee).toBeNull();
  });

  it('deadline_priority ordering: deadline asc nulls last, then priority, LIMIT after order', () => {
    ledger.create({ title: 'no-deadline-high', priority: 'high' });
    ledger.create({ title: 'late-low', deadline: '2026-09-01', priority: 'low' });
    ledger.create({ title: 'soon-normal', deadline: '2026-07-15', priority: 'normal' });
    ledger.create({ title: 'soon-high', deadline: '2026-07-15', priority: 'high' });
    const top2 = ledger.list({ order: 'deadline_priority', limit: 2 });
    // The true top-2 by (deadline, priority) - NOT insertion order.
    expect(top2.map((t) => t.title)).toEqual(['soon-high', 'soon-normal']);
    const all = ledger.list({ order: 'deadline_priority' });
    expect(all[all.length - 1]?.title).toBe('no-deadline-high'); // nulls last
  });

  it('filters: status, channel, search', () => {
    ledger.create({ title: 'alpha work', status: 'review', source_channel: 'slack:C1' });
    ledger.create({ title: 'beta work', assignee: 'worker-b' });
    expect(ledger.list({ status: 'review' })).toHaveLength(1);
    expect(ledger.list({ channel: 'slack:C1' })).toHaveLength(1);
    expect(ledger.list({ search: 'worker-b' })).toHaveLength(1);
    expect(ledger.list({ search: 'alpha' })[0]?.title).toBe('alpha work');
  });

  it('getTasks() satisfies TaskSource with canonical ordering', () => {
    ledger.create({ title: 'b', deadline: '2026-08-01' });
    ledger.create({ title: 'a', deadline: '2026-07-15' });
    const tasks = ledger.getTasks();
    expect(tasks[0]?.title).toBe('a');
    expect(typeof tasks[0]?.deadline).toBe('number'); // OperatorTask numeric contract
  });

  it('payloadHash changes on mutation and is stable otherwise', () => {
    const t = ledger.create({ title: 'x' });
    const h1 = ledger.payloadHash();
    expect(ledger.payloadHash()).toBe(h1);
    ledger.update(t.id, { status: 'done' });
    expect(ledger.payloadHash()).not.toBe(h1);
  });

  it('no-update notes: record + scoped max id', () => {
    expect(ledger.maxNoUpdateId()).toBe(0);
    const a = ledger.recordNoUpdate('reconcile:slack:C1', 'greeting only');
    ledger.recordNoUpdate('reconcile:chatwork:9', 'bot chatter');
    expect(ledger.maxNoUpdateId('reconcile:slack:C1')).toBe(a.id);
    expect(ledger.maxNoUpdateId()).toBeGreaterThan(a.id);
    expect(() => ledger.recordNoUpdate('', 'x')).toThrow(/scope/);
  });
});
