/**
 * After every fresh session the conductor reads its own notebook back.
 * The re-ground is exactly what task_list would show: open owner cards,
 * newest first, bounded so a 171-card stale tail cannot flood the buffer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { buildBoardReground } from '../../src/operator/board-reground.js';

describe('buildBoardReground', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db);
  });

  it('lists open owner tasks and excludes done ones', () => {
    const a = ledger.create({ title: 'open card A' });
    const b = ledger.create({ title: 'finished card B' });
    ledger.update(b.id, { status: 'done' });
    const text = buildBoardReground(ledger);
    expect(text).toContain('[BOARD REGROUND]');
    expect(text).toContain('[/BOARD REGROUND]');
    expect(text).toContain(`#${a.id}`);
    expect(text).toContain('open card A');
    expect(text).not.toContain('finished card B');
  });

  it('covers every open status, not just pending', () => {
    const a = ledger.create({ title: 'card in progress' });
    ledger.update(a.id, { status: 'in_progress' });
    const b = ledger.create({ title: 'card in review' });
    ledger.update(b.id, { status: 'review' });
    const text = buildBoardReground(ledger);
    expect(text).toContain('[in_progress] card in progress');
    expect(text).toContain('[review] card in review');
  });

  it('caps output and says how many were omitted', () => {
    for (let i = 0; i < 5; i++) ledger.create({ title: `card ${i}` });
    const text = buildBoardReground(ledger, 2);
    expect(text.match(/^- #/gm)?.length).toBe(2);
    expect(text).toContain('(+3 more open)');
  });

  it('an empty board says so instead of rendering nothing', () => {
    const text = buildBoardReground(ledger);
    expect(text).toContain('(no open tasks)');
  });
});
