import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';

const TEMPORAL_COLUMNS = [
  'due_at',
  'deadline_offset_minutes',
  'revision',
  'temporal_epoch',
  'temporal_reconciled_occurrence_key',
  'last_temporal_checked_at',
  'next_temporal_check_at',
  'last_temporal_attempt_id',
] as const;

function columnNames(db: SQLiteDatabase): string[] {
  return (db.prepare('PRAGMA table_info(operator_tasks)').all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}

function objectSql(db: SQLiteDatabase, type: 'table' | 'index', name: string): string {
  const row = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get(type, name) as { sql: string | null } | undefined;
  return row?.sql ?? '';
}

describe('Story A2 Task 1: temporal task schema migration', () => {
  it('creates the temporal columns, constrained tables, and lookup indexes on a fresh database', () => {
    const db = new Database(':memory:');
    new TaskLedger(db);

    expect(columnNames(db)).toEqual(expect.arrayContaining([...TEMPORAL_COLUMNS]));

    const generationSql = objectSql(db, 'table', 'operator_temporal_generations');
    expect(generationSql).toContain('generation_key TEXT PRIMARY KEY');
    expect(generationSql).toContain(
      "'active','resolved','final_no_update','deferred','exhausted','superseded'"
    );

    const effectSql = objectSql(db, 'table', 'operator_temporal_effects');
    expect(effectSql).toContain('workorder_attempt_id INTEGER PRIMARY KEY');
    expect(effectSql).toContain("'resolved','final_no_update','deferred'");

    for (const index of [
      'idx_operator_tasks_temporal_candidates',
      'idx_operator_temporal_generations_task_occurrence',
      'idx_operator_temporal_generations_workorder',
      'idx_operator_temporal_effects_task_occurrence',
    ]) {
      expect(objectSql(db, 'index', index)).not.toBe('');
    }
    db.close();
  });

  it('upgrades legacy rows without rewriting values or blindly backfilling temporal epochs', () => {
    const db = new Database(':memory:');
    db.exec(`
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
      );
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
      temporal_epoch: 0,
    });
    expect(row.due_at).toBeNull();
    expect(row.temporal_reconciled_occurrence_key).toBeNull();
    db.close();
  });

  it('is idempotent and serializes two constructors against one legacy file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-temporal-migration-'));
    const dbPath = join(dir, 'operator.db');
    try {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE operator_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','in_progress','review','blocked','done','cancelled')),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
          assignee TEXT, deadline TEXT, source_channel TEXT, source_event_id TEXT,
          latest_event TEXT, auto_created INTEGER NOT NULL DEFAULT 1,
          confirmed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO operator_tasks (title, created_at, updated_at) VALUES ('survivor', 1, 1);
      `);
      seed.close();

      const connectionA = new Database(dbPath);
      const connectionB = new Database(dbPath);
      new TaskLedger(connectionA);
      new TaskLedger(connectionB);
      new TaskLedger(connectionA);

      expect(columnNames(connectionA)).toEqual(expect.arrayContaining([...TEMPORAL_COLUMNS]));
      expect(columnNames(connectionB)).toEqual(expect.arrayContaining([...TEMPORAL_COLUMNS]));
      expect(connectionA.prepare('SELECT COUNT(*) AS count FROM operator_tasks').get()).toEqual({
        count: 1,
      });
      expect(
        connectionA
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'operator_temporal_%'"
          )
          .get()
      ).toEqual({ count: 2 });
      expect(
        connectionA
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_operator_temporal_%'"
          )
          .get()
      ).toEqual({ count: 3 });
      connectionA.close();
      connectionB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
