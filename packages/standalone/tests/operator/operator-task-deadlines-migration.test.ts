import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';

const DEADLINE_COLUMNS = ['due_at', 'deadline_offset_minutes', 'revision'] as const;

/** Every column the retired reconciliation subsystem used to maintain. */
const RETIRED_COLUMNS = [
  'temporal_epoch',
  'temporal_reconciled_occurrence_key',
  'last_temporal_checked_at',
  'next_temporal_check_at',
  'last_temporal_attempt_id',
] as const;

const LEGACY_TASKS_TABLE = `
  CREATE TABLE operator_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','in_progress','review','blocked','done','cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
    assignee TEXT,
    deadline TEXT,
    source_channel TEXT,
    source_event_id TEXT,
    latest_event TEXT,
    auto_created INTEGER NOT NULL DEFAULT 1,
    confirmed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`;

function columnNames(db: SQLiteDatabase): string[] {
  return (db.prepare('PRAGMA table_info(operator_tasks)').all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}

function objectSql(db: SQLiteDatabase, type: 'table' | 'index' | 'trigger', name: string): string {
  const row = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get(type, name) as { sql: string | null } | undefined;
  return row?.sql ?? '';
}

describe('operator task deadline migration', () => {
  it('creates the deadline and revision columns on a fresh database', () => {
    const db = new Database(':memory:');
    new TaskLedger(db);

    expect(columnNames(db)).toEqual(expect.arrayContaining([...DEADLINE_COLUMNS]));
    for (const column of RETIRED_COLUMNS) {
      expect(columnNames(db)).not.toContain(column);
    }
    db.close();
  });

  it('upgrades legacy rows without rewriting their values', () => {
    const db = new Database(':memory:');
    db.exec(`${LEGACY_TASKS_TABLE}
      INSERT INTO operator_tasks
        (title, status, priority, deadline, latest_event, created_at, updated_at)
      VALUES ('legacy scheduled', 'pending', 'high', '2026-07-21', 'unchanged', 11, 22);
    `);

    new TaskLedger(db);

    const row = db.prepare('SELECT * FROM operator_tasks WHERE id = 1').get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      title: 'legacy scheduled',
      status: 'pending',
      priority: 'high',
      deadline: '2026-07-21',
      latest_event: 'unchanged',
      created_at: 11,
      updated_at: 22,
      revision: 0,
    });
    expect(row.due_at).toBeNull();
    db.close();
  });

  it('is idempotent and serializes two constructors against one legacy file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-deadline-migration-'));
    const dbPath = join(dir, 'operator.db');
    try {
      const seed = new Database(dbPath);
      seed.exec(`${LEGACY_TASKS_TABLE}
        INSERT INTO operator_tasks (title, created_at, updated_at) VALUES ('survivor', 1, 1);
      `);
      seed.close();

      const connectionA = new Database(dbPath);
      const connectionB = new Database(dbPath);
      new TaskLedger(connectionA);
      new TaskLedger(connectionB);
      new TaskLedger(connectionA);

      expect(columnNames(connectionA)).toEqual(expect.arrayContaining([...DEADLINE_COLUMNS]));
      expect(columnNames(connectionB)).toEqual(expect.arrayContaining([...DEADLINE_COLUMNS]));
      expect(connectionA.prepare('SELECT COUNT(*) AS count FROM operator_tasks').get()).toEqual({
        count: 1,
      });
      connectionA.close();
      connectionB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a legacy deadline write clears the exact-time pair and advances revision', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const task = ledger.create({
      title: 'mixed-version task',
      due_at: '2026-07-22T09:00:00+09:00',
    });

    db.prepare(`UPDATE operator_tasks SET deadline = ?, updated_at = ? WHERE id = ?`).run(
      '2026-08-01',
      400,
      task.id
    );

    expect(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(task.id)).toMatchObject({
      deadline: '2026-08-01',
      due_at: null,
      deadline_offset_minutes: null,
      revision: task.revision + 1,
    });
    expect(objectSql(db, 'trigger', 'trg_operator_tasks_legacy_deadline_write')).not.toBe('');
    db.close();
  });

  it('advances revision for legacy owner status and content writes', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const task = ledger.create({ title: 'legacy content task', deadline: '2026-07-21' });

    db.prepare(`UPDATE operator_tasks SET status = 'done', updated_at = 300 WHERE id = ?`).run(
      task.id
    );
    expect(db.prepare('SELECT revision FROM operator_tasks WHERE id = ?').get(task.id)).toEqual({
      revision: task.revision + 1,
    });

    db.prepare(
      `UPDATE operator_tasks
       SET title = 'legacy rename', priority = 'high', assignee = 'owner',
           latest_event = 'legacy edit', confirmed = 1, updated_at = 500
       WHERE id = ?`
    ).run(task.id);

    expect(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(task.id)).toMatchObject({
      title: 'legacy rename',
      priority: 'high',
      assignee: 'owner',
      latest_event: 'legacy edit',
      confirmed: 1,
      revision: task.revision + 2,
    });
    expect(objectSql(db, 'trigger', 'trg_operator_tasks_legacy_status_write')).not.toBe('');
    expect(objectSql(db, 'trigger', 'trg_operator_tasks_legacy_content_write')).not.toBe('');
    db.close();
  });
});

/**
 * A database written by a release that still ran temporal reconciliation. The upgrade has
 * to remove what that subsystem owned - including an open system row the serial consumer
 * would otherwise claim and have no turn contract for.
 */
describe('retiring temporal reconciliation storage', () => {
  // A temporal-era table, not a pre-Stage-2 one: every release that carried temporal
  // storage already had 'failed' in the status CHECK, so the copy-swap rebuild in
  // upgradeSchema is correctly skipped here.
  function seedTemporalSchema(db: SQLiteDatabase): void {
    db.exec(`
      CREATE TABLE operator_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','in_progress','review','blocked','done','cancelled','failed')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
        kind TEXT NOT NULL DEFAULT 'owner' CHECK (kind IN ('owner','system')),
        payload TEXT,
        assignee TEXT,
        deadline TEXT,
        due_at INTEGER,
        deadline_offset_minutes INTEGER,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        temporal_epoch INTEGER NOT NULL DEFAULT 0 CHECK (temporal_epoch >= 0),
        temporal_reconciled_occurrence_key TEXT,
        last_temporal_checked_at INTEGER,
        next_temporal_check_at INTEGER,
        last_temporal_attempt_id INTEGER,
        source_channel TEXT,
        source_event_id TEXT,
        latest_event TEXT,
        auto_created INTEGER NOT NULL DEFAULT 1,
        confirmed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE operator_temporal_generations (
        generation_key TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
        temporal_epoch INTEGER NOT NULL CHECK (temporal_epoch >= 0),
        occurrence_key TEXT NOT NULL,
        check_at INTEGER NOT NULL,
        disposition TEXT NOT NULL DEFAULT 'active',
        last_workorder_id INTEGER REFERENCES operator_tasks(id),
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE operator_temporal_effects (
        workorder_attempt_id INTEGER PRIMARY KEY REFERENCES operator_tasks(id),
        task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
        generation_key TEXT NOT NULL REFERENCES operator_temporal_generations(generation_key),
        occurrence_key TEXT NOT NULL,
        outcome TEXT NOT NULL,
        before_revision INTEGER NOT NULL,
        after_revision INTEGER NOT NULL,
        changed_fields TEXT NOT NULL,
        reason TEXT NOT NULL,
        context_packet_id TEXT NOT NULL,
        context_packet_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_operator_tasks_temporal_scan_id
        ON operator_tasks(id)
        WHERE kind = 'owner' AND next_temporal_check_at IS NOT NULL;
      CREATE INDEX idx_operator_temporal_generations_workorder
        ON operator_temporal_generations(last_workorder_id);

      INSERT INTO operator_tasks
        (title, status, kind, deadline, temporal_epoch, next_temporal_check_at,
         created_at, updated_at)
      VALUES ('owner row that survives', 'pending', 'owner', '2026-07-21', 3, 999, 1, 1);
      INSERT INTO operator_tasks
        (title, status, kind, source_channel, source_event_id, payload, created_at, updated_at)
      VALUES ('temporal attempt', 'pending', 'system', 'workorder:temporal', 'g1',
              '{"attempts":1}', 1, 1);
      INSERT INTO operator_temporal_generations
        (generation_key, task_id, temporal_epoch, occurrence_key, check_at, disposition,
         last_workorder_id, created_at, updated_at)
      VALUES ('g1', 1, 3, 'epoch:3:date:2026-07-21', 999, 'active', 2, 1, 1);
    `);
  }

  it('drops the tables, indexes and marker columns and keeps the owner rows', () => {
    const db = new Database(':memory:');
    seedTemporalSchema(db);

    new TaskLedger(db);

    for (const column of RETIRED_COLUMNS) {
      expect(columnNames(db)).not.toContain(column);
    }
    expect(objectSql(db, 'table', 'operator_temporal_generations')).toBe('');
    expect(objectSql(db, 'table', 'operator_temporal_effects')).toBe('');
    expect(objectSql(db, 'index', 'idx_operator_tasks_temporal_scan_id')).toBe('');
    expect(objectSql(db, 'index', 'idx_operator_temporal_generations_workorder')).toBe('');

    expect(db.prepare('SELECT * FROM operator_tasks WHERE id = 1').get()).toMatchObject({
      title: 'owner row that survives',
      status: 'pending',
      deadline: '2026-07-21',
    });
    db.close();
  });

  it('cancels an open temporal system row nothing can run any more', () => {
    const db = new Database(':memory:');
    seedTemporalSchema(db);

    const ledger = new TaskLedger(db);

    expect(db.prepare('SELECT * FROM operator_tasks WHERE id = 2').get()).toMatchObject({
      status: 'cancelled',
      latest_event: 'temporal-reconciliation-retired',
    });
    expect(ledger.countPendingWorkOrders()).toBe(0);
    expect(ledger.claimNextWorkOrder()).toBeNull();
    db.close();
  });

  it('is idempotent: a second construction finds nothing left to retire', () => {
    const db = new Database(':memory:');
    seedTemporalSchema(db);

    new TaskLedger(db);
    expect(() => new TaskLedger(db)).not.toThrow();

    for (const column of RETIRED_COLUMNS) {
      expect(columnNames(db)).not.toContain(column);
    }
    db.close();
  });
});
