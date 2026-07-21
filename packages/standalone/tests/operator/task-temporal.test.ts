import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveTemporalState,
  occurrenceKeyForTask,
  parseExactDueAt,
} from '../../src/operator/task-temporal.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database from '../../src/sqlite.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Story A2 Task 2: exact temporal normalization', () => {
  it.each([
    ['2026-07-21T14:00:00Z', Date.UTC(2026, 6, 21, 14), '2026-07-21', 0],
    ['2026-07-21T14:00:00+09:00', Date.UTC(2026, 6, 21, 5), '2026-07-21', 540],
    ['2026-07-20T23:30:00-05:00', Date.UTC(2026, 6, 21, 4, 30), '2026-07-20', -300],
  ])('normalizes explicit-offset RFC 3339 input %s', (input, dueAt, deadline, offsetMinutes) => {
    expect(parseExactDueAt(input)).toEqual({ dueAt, deadline, offsetMinutes });
  });

  it.each([
    '2026-07-21T14:00:00',
    '2026-07-21 14:00:00Z',
    '2026-02-30T14:00:00Z',
    '2026-07-21T25:00:00+09:00',
    'not-a-date',
  ])('rejects invalid or offset-free exact input %s', (input) => {
    expect(() => parseExactDueAt(input)).toThrow(/RFC 3339/);
  });

  it('builds epoch-qualified exact and date occurrence keys', () => {
    expect(occurrenceKeyForTask({ temporalEpoch: 3, dueAt: 123, deadlineIso: '2026-07-21' })).toBe(
      'epoch:3:due:123'
    );
    expect(occurrenceKeyForTask({ temporalEpoch: 4, dueAt: null, deadlineIso: '2026-07-21' })).toBe(
      'epoch:4:date:2026-07-21'
    );
    expect(occurrenceKeyForTask({ temporalEpoch: 0, dueAt: null, deadlineIso: null })).toBeNull();
  });
});

describe('Story A2 Task 3: derived temporal state', () => {
  const now = Date.parse('2026-07-21T15:00:00Z');

  it.each([
    [{ status: 'done', dueAt: now - 1, deadlineIso: '2026-07-21' }, 'closed'],
    [{ status: 'cancelled', dueAt: null, deadlineIso: null }, 'closed'],
    [{ status: 'pending', dueAt: now + 1, deadlineIso: '2026-07-22' }, 'exact_upcoming'],
    [{ status: 'pending', dueAt: now, deadlineIso: '2026-07-21' }, 'exact_overdue'],
    [{ status: 'blocked', dueAt: now - 1, deadlineIso: '2026-07-21' }, 'exact_overdue'],
    [{ status: 'review', dueAt: null, deadlineIso: null }, 'unscheduled'],
  ] as const)('derives %s as %s', (task, expected) => {
    expect(deriveTemporalState({ ...task, deadlineOffsetMinutes: null }, now, 'Asia/Seoul')).toBe(
      expected
    );
  });

  it('uses the captured numeric offset for date-only boundaries', () => {
    const task = { status: 'pending', dueAt: null, deadlineOffsetMinutes: 540 };
    expect(deriveTemporalState({ ...task, deadlineIso: '2026-07-22' }, now, 'UTC')).toBe(
      'date_due'
    );
    expect(deriveTemporalState({ ...task, deadlineIso: '2026-07-21' }, now, 'UTC')).toBe(
      'date_overdue'
    );
    expect(deriveTemporalState({ ...task, deadlineIso: '2026-07-23' }, now, 'UTC')).toBe(
      'date_upcoming'
    );
  });

  it('uses the injected daemon IANA zone for legacy date-only rows', () => {
    const task = {
      status: 'in_progress',
      dueAt: null,
      deadlineOffsetMinutes: null,
    };
    expect(deriveTemporalState({ ...task, deadlineIso: '2026-07-22' }, now, 'Asia/Seoul')).toBe(
      'date_due'
    );
    expect(deriveTemporalState({ ...task, deadlineIso: '2026-07-21' }, now, 'Asia/Seoul')).toBe(
      'date_overdue'
    );
    expect(deriveTemporalState({ ...task, deadlineIso: '2026-07-23' }, now, 'Asia/Seoul')).toBe(
      'date_upcoming'
    );
  });
});

describe('Story A2 Task 2: ledger revision and temporal epoch rules', () => {
  it('creates exact and date-only schedules at revision 1 and epoch 1', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);

    const exact = ledger.create({
      title: 'exact',
      due_at: '2026-07-21T14:00:00+09:00',
    });
    const dateOnly = ledger.create({ title: 'date', deadline: '2026-07-22' });
    const unscheduled = ledger.create({ title: 'none' });

    expect(exact).toMatchObject({
      dueAt: Date.UTC(2026, 6, 21, 5),
      deadlineIso: '2026-07-21',
      deadlineOffsetMinutes: 540,
      revision: 1,
      temporalEpoch: 1,
    });
    expect(dateOnly).toMatchObject({ revision: 1, temporalEpoch: 1 });
    expect(unscheduled).toMatchObject({ revision: 1, temporalEpoch: 0 });
    db.close();
  });

  it('rejects conflicting exact and date projections', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    expect(() =>
      ledger.create({
        title: 'conflict',
        due_at: '2026-07-21T14:00:00+09:00',
        deadline: '2026-07-22',
      })
    ).toThrow(/conflict/);
    db.close();
  });

  it('preserves timestamps and revision for no-ops but increments once for real changes', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const task = ledger.create({ title: 'task', priority: 'normal' });

    clock.mockReturnValue(2_000);
    const noOp = ledger.update(task.id, { title: 'task', priority: 'normal' });
    expect(noOp).toMatchObject({ revision: 1, updatedAt: 1_000, temporalEpoch: 0 });

    const changed = ledger.update(task.id, { priority: 'high', confirmed: true });
    expect(changed).toMatchObject({ revision: 2, updatedAt: 2_000, temporalEpoch: 0 });
    db.close();
  });

  it('applies exact/date clearing contracts and advances epoch only for new occurrences', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const task = ledger.create({
      title: 'scheduled',
      due_at: '2026-07-21T14:00:00+09:00',
    });

    const dateOnly = ledger.update(task.id, { deadline: '2026-07-22' });
    expect(dateOnly).toMatchObject({
      dueAt: null,
      deadlineIso: '2026-07-22',
      deadlineOffsetMinutes: 540,
      revision: 2,
      temporalEpoch: 2,
    });

    const exactAgain = ledger.update(task.id, { due_at: '2026-07-22T09:00:00+09:00' });
    expect(exactAgain).toMatchObject({
      deadlineIso: '2026-07-22',
      deadlineOffsetMinutes: 540,
      revision: 3,
      temporalEpoch: 3,
    });

    const clearedExact = ledger.update(task.id, { due_at: null });
    expect(clearedExact).toMatchObject({
      dueAt: null,
      deadlineIso: '2026-07-22',
      deadlineOffsetMinutes: 540,
      revision: 4,
      temporalEpoch: 4,
    });

    const clearedDate = ledger.update(task.id, { deadline: null });
    expect(clearedDate).toMatchObject({
      dueAt: null,
      deadlineIso: null,
      deadlineOffsetMinutes: null,
      revision: 5,
      temporalEpoch: 5,
    });
    db.close();
  });

  it('reopens a terminal scheduled task as a new epoch and clears temporal markers', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const task = ledger.create({ title: 'scheduled', deadline: '2026-07-21', status: 'done' });
    db.prepare(
      `UPDATE operator_tasks SET temporal_reconciled_occurrence_key = 'old',
       last_temporal_checked_at = 10, next_temporal_check_at = 20 WHERE id = ?`
    ).run(task.id);

    const reopened = ledger.update(task.id, { status: 'pending' });
    expect(reopened).toMatchObject({
      revision: 2,
      temporalEpoch: 2,
      temporalReconciledOccurrenceKey: null,
      lastTemporalCheckedAt: null,
      nextTemporalCheckAt: null,
    });
    db.close();
  });

  it('applies the same one-increment and no-op contract to duplicate source upserts', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const created = ledger.create({
      title: 'source task',
      source_channel: 'synthetic:room',
      source_event_id: 'event-1',
      deadline: '2026-07-21',
    });

    clock.mockReturnValue(2_000);
    const noOp = ledger.create({
      title: 'source task',
      source_channel: 'synthetic:room',
      source_event_id: 'event-1',
      deadline: '2026-07-21',
    });
    expect(noOp).toMatchObject({ revision: 1, updatedAt: 1_000, temporalEpoch: 1 });

    const changed = ledger.create({
      title: 'source task',
      source_channel: 'synthetic:room',
      source_event_id: 'event-1',
      deadline: '2026-07-22',
    });
    expect(changed.id).toBe(created.id);
    expect(changed).toMatchObject({ revision: 2, updatedAt: 2_000, temporalEpoch: 2 });
    db.close();
  });
});
