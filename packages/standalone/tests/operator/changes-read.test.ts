/**
 * Reading the effect ledger back.
 *
 * The ledger existed for one commit with no reader, which is the failure this rebuild
 * keeps finding: a table nothing consumes proves nothing. Then the first reader shipped
 * with seven green tests that drove everything EXCEPT the tool path, and the tool path
 * was the part that could state a falsehood.
 *
 * Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { parseChangesSince, readChanges } from '../../src/operator/changes-projection.js';

describe('changes_read projection', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-07-28T12:00:00Z');
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => now });
  });

  const read = (input: Parameters<typeof readChanges>[1] = {}) => readChanges(ledger, input, now);

  it('reports what changed together with how much of it is explained', () => {
    ledger.create(
      { title: 'explained', source_channel: 'chat:C001', source_event_id: 'evt_1' },
      { runId: 'mr_1' }
    );
    ledger.create({ title: 'unexplained' }, { runId: 'mr_1' });

    const result = read();
    expect(result).toMatchObject({
      success: true,
      coverage: { attributed: 1, unattributed: 1 },
      total: 2,
      returned: 2,
    });
    expect(result.success && result.changes.map((c) => c.cause_state)).toEqual([
      'unattributed',
      'attributed',
    ]);
    expect(result.success && result.since).toBe('2026-07-27T12:00:00.000Z');
  });

  // The defect this projection was rewritten for: rows are capped, coverage is not, and
  // the newest changes skew unattributed. A caller seeing only capped rows could say
  // "nothing I did is explainable" while the same payload said otherwise.
  it('states the full match count beside a capped page', () => {
    for (let i = 0; i < 4; i += 1) {
      ledger.create(
        { title: `explained ${i}`, source_channel: 'chat:C001', source_event_id: `evt_${i}` },
        { runId: 'mr_1' }
      );
    }
    now += 1000;
    for (let i = 0; i < 8; i += 1) ledger.create({ title: `unexplained ${i}` });

    const result = read({ limit: 5 });
    expect(result).toMatchObject({ coverage: { attributed: 4, unattributed: 8 }, total: 12 });
    expect(result.success && result.returned).toBe(5);
    // Every visible row is unattributed - and total says that is not the whole story.
    expect(result.success && result.changes.every((c) => c.cause_state === 'unattributed')).toBe(
      true
    );
  });

  // Coverage and rows must describe the same population, or the two halves of one answer
  // disagree and a reader cannot tell which is wrong.
  it('scopes coverage to the same target type the rows came from', () => {
    ledger.create({ title: 'a', source_channel: 'chat:C001', source_event_id: 'evt_1' });
    ledger.create({ title: 'b' });

    const tasks = read({ target_type: 'task' });
    expect(tasks).toMatchObject({ coverage: { attributed: 1, unattributed: 1 }, total: 2 });

    const slots = read({ target_type: 'report_slot' });
    expect(slots).toMatchObject({ coverage: { attributed: 0, unattributed: 0 }, total: 0 });
    expect(slots.success && slots.changes).toEqual([]);
  });

  // total must follow the cause_state filter, or a filtered page reports someone else's
  // count as its own.
  it('counts only what the cause_state filter selected', () => {
    ledger.create({ title: 'a', source_channel: 'chat:C001', source_event_id: 'evt_1' });
    ledger.create({ title: 'b' });
    ledger.create({ title: 'c' });

    expect(read({ cause_state: 'attributed' })).toMatchObject({ total: 1, returned: 1 });
    expect(read({ cause_state: 'unattributed' })).toMatchObject({ total: 2, returned: 2 });
  });

  it('excludes changes from before the window', () => {
    ledger.create({ title: 'old' });
    now += 60 * 60 * 1000;
    ledger.create({ title: 'recent' });

    const result = readChanges(ledger, { since: '30m' }, now);
    expect(result).toMatchObject({ total: 1, returned: 1 });
  });

  // "No rows" and "nothing changed" are the same sentence to a reader, and only one of
  // them is ever true. A misspelt filter must not be able to say the second.
  it('refuses a filter value it does not recognise instead of returning nothing', () => {
    ledger.create({ title: 'a' });

    expect(read({ target_type: 'tasks' })).toMatchObject({
      success: false,
      code: 'invalid_argument',
    });
    expect(read({ cause_state: 'Attributed' })).toMatchObject({ success: false });
    expect(read({ limit: 0 })).toMatchObject({ success: false });
    expect(read({ limit: -5 })).toMatchObject({ success: false });
    expect(read({ limit: 1.5 })).toMatchObject({ success: false });
    expect(read({ limit: 'abc' })).toMatchObject({ success: false });
  });

  it('caps the page at the advertised maximum', () => {
    const result = read({ limit: 100_000 });
    expect(result.success).toBe(true);
    // The clamp is what the description promises; an uncapped limit reached SQL before.
    expect(read({ limit: 500 }).success).toBe(true);
  });
});

describe('parseChangesSince', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('defaults to a day when nothing is asked for', () => {
    expect(parseChangesSince(undefined, now)).toBe(now - day);
    expect(parseChangesSince('   ', now)).toBe(now - day);
  });

  it('accepts relative and absolute windows', () => {
    expect(parseChangesSince('3d', now)).toBe(now - 3 * day);
    expect(parseChangesSince('6h', now)).toBe(now - 6 * 60 * 60 * 1000);
    // Deliberately NOT 24h back: an absolute date that resolved to the default window
    // would make this assertion pass with the parsing removed entirely.
    expect(parseChangesSince('2026-07-25T09:00:00Z', now)).toBe(Date.parse('2026-07-25T09:00:00Z'));
  });

  // A future window returns nothing, and nothing reads as "nothing changed".
  it('never resolves to a window that has not happened', () => {
    expect(parseChangesSince('2027-01-01T00:00:00Z', now)).toBe(now);
  });

  // A model emitting epoch milliseconds, or an array, used to crash the tool on .trim().
  it('survives input that is not a string', () => {
    for (const value of [1785240000000, 3, {}, ['3d'], true, null]) {
      expect(parseChangesSince(value, now)).toBe(now - day);
    }
  });

  // An unclamped window produced a timestamp that threw on the way back out.
  it('cannot produce a timestamp that fails to serialise', () => {
    const since = parseChangesSince('99999999999d', now);
    expect(() => new Date(since).toISOString()).not.toThrow();
    expect(since).toBe(0);
  });

  it('falls back to the default rather than failing on nonsense', () => {
    expect(parseChangesSince('last tuesday', now)).toBe(now - day);
  });
});
