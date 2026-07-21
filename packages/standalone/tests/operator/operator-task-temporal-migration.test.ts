import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { applyOperatorTaskTemporalMigration } from '../../src/db/migrations/operator-task-temporal.js';
import { temporalReceiptInvariantError } from '../../src/operator/temporal-effect.js';
import { occurrenceKeyForTask, temporalGenerationKey } from '../../src/operator/task-temporal.js';
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

function objectSql(db: SQLiteDatabase, type: 'table' | 'index' | 'trigger', name: string): string {
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
    expect(effectSql).toContain('attestation_version INTEGER NOT NULL DEFAULT 0');

    for (const index of [
      'idx_operator_tasks_temporal_open_event',
      'idx_operator_temporal_generations_identity',
      'idx_operator_temporal_generations_active',
      'idx_operator_temporal_generations_workorder',
      'idx_operator_temporal_effects_task_occurrence',
    ]) {
      expect(objectSql(db, 'index', index)).not.toBe('');
    }
    expect(objectSql(db, 'index', 'idx_operator_tasks_temporal_candidates')).toBe('');
    expect(objectSql(db, 'index', 'idx_operator_temporal_generations_task_occurrence')).toBe('');
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
      ).toEqual({ count: 4 });
      connectionA.close();
      connectionB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes exact-time state across a legacy deadline write and re-upgrade', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const task = ledger.create({
      title: 'mixed-version task',
      due_at: '2026-07-22T09:00:00+09:00',
    });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = temporalGenerationKey(task.id, occurrenceKey, task.dueAt!);
    const generation = ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    db.prepare(
      `UPDATE operator_tasks
       SET temporal_reconciled_occurrence_key = 'old-occurrence',
           last_temporal_checked_at = 100,
           next_temporal_check_at = 200,
           last_temporal_attempt_id = 300
       WHERE id = ?`
    ).run(task.id);

    db.prepare(`UPDATE operator_tasks SET deadline = ?, updated_at = ? WHERE id = ?`).run(
      '2026-08-01',
      400,
      task.id
    );
    new TaskLedger(db);

    expect(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(task.id)).toMatchObject({
      deadline: '2026-08-01',
      due_at: null,
      deadline_offset_minutes: null,
      revision: 2,
      temporal_epoch: 2,
      temporal_reconciled_occurrence_key: null,
      last_temporal_checked_at: null,
      next_temporal_check_at: null,
      last_temporal_attempt_id: null,
    });
    expect(objectSql(db, 'trigger', 'trg_operator_tasks_legacy_deadline_write')).not.toBe('');
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('superseded');
    expect(ledger.getWorkOrderById(generation.workOrder.id)?.status).toBe('cancelled');
    db.close();
  });

  it('normalizes legacy owner status transitions across downgrade and re-upgrade', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const task = ledger.create({
      title: 'mixed-version status task',
      due_at: '2026-07-22T09:00:00+09:00',
    });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = temporalGenerationKey(task.id, occurrenceKey, task.dueAt!);
    const generation = ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    db.prepare(
      `UPDATE operator_tasks
       SET temporal_reconciled_occurrence_key = ?, last_temporal_checked_at = 100,
           next_temporal_check_at = 200, last_temporal_attempt_id = ?
       WHERE id = ?`
    ).run(occurrenceKey, generation.workOrder.id, task.id);

    db.prepare(`UPDATE operator_tasks SET status = 'done', updated_at = 300 WHERE id = ?`).run(
      task.id
    );
    expect(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(task.id)).toMatchObject({
      status: 'done',
      revision: 2,
      temporal_epoch: 1,
    });
    expect(ledger.getTemporalGeneration(generationKey)?.disposition).toBe('superseded');
    expect(ledger.getWorkOrderById(generation.workOrder.id)?.status).toBe('cancelled');

    db.prepare(`UPDATE operator_tasks SET status = 'pending', updated_at = 400 WHERE id = ?`).run(
      task.id
    );
    new TaskLedger(db);

    expect(db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(task.id)).toMatchObject({
      status: 'pending',
      revision: 3,
      temporal_epoch: 2,
      temporal_reconciled_occurrence_key: null,
      last_temporal_checked_at: null,
      next_temporal_check_at: null,
      last_temporal_attempt_id: null,
    });
    expect(objectSql(db, 'trigger', 'trg_operator_tasks_legacy_status_write')).not.toBe('');
    db.close();
  });

  it('advances revision for legacy owner content writes', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const task = ledger.create({ title: 'legacy content task', deadline: '2026-07-21' });

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
      revision: 2,
      temporal_epoch: 1,
    });
    expect(objectSql(db, 'trigger', 'trg_operator_tasks_legacy_content_write')).not.toBe('');
    db.close();
  });

  it('enforces temporal foreign keys on every operator connection', () => {
    const db = new Database(':memory:');
    new TaskLedger(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO operator_temporal_generations
             (generation_key, task_id, temporal_epoch, occurrence_key, check_at,
              disposition, created_at, updated_at)
           VALUES ('orphan', 999, 0, 'date:2026-07-21', 1, 'active', 1, 1)`
        )
        .run()
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('keeps old-shape receipts non-authoritative on a fresh current schema', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const task = ledger.create({ title: 'fresh legacy writer task', deadline: '2026-07-21' });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = temporalGenerationKey(
      task.id,
      occurrenceKey,
      Date.parse('2026-07-21T15:00:00Z')
    );
    const generation = ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: Date.parse('2026-07-21T15:00:00Z'),
      sourceChannel: null,
      sourceEventId: null,
    });

    db.prepare(
      `INSERT INTO operator_temporal_effects
         (workorder_attempt_id, task_id, generation_key, occurrence_key, outcome,
          before_revision, after_revision, changed_fields, reason,
          context_packet_id, context_packet_sha256, next_temporal_check_at, created_at)
       VALUES (?, ?, ?, ?, 'final_no_update', 1, 2, '[]', 'old binary receipt',
               'ctxp_old_shape', ?, NULL, ?)`
    ).run(
      generation.workOrder.id,
      task.id,
      generationKey,
      occurrenceKey,
      'a'.repeat(64),
      Date.parse('2026-07-21T15:00:00Z')
    );

    expect(ledger.getTemporalEffect(generation.workOrder.id)?.attestationVersion).toBe(0);
    db.close();
  });

  it('classifies a pre-attestation receipt as readable but non-authoritative', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db, {
      now: () => Date.parse('2026-07-21T15:00:00Z'),
      timeZone: 'Asia/Seoul',
    });
    const task = ledger.create({ title: 'legacy receipt task', deadline: '2026-07-21' });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = temporalGenerationKey(
      task.id,
      occurrenceKey,
      Date.parse('2026-07-21T15:00:00Z')
    );
    const generation = ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: Date.parse('2026-07-21T15:00:00Z'),
      sourceChannel: null,
      sourceEventId: null,
    });
    db.exec(`
      DROP TABLE operator_temporal_effects;
      CREATE TABLE operator_temporal_effects (
        workorder_attempt_id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL,
        generation_key TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        outcome TEXT NOT NULL,
        before_revision INTEGER NOT NULL,
        after_revision INTEGER NOT NULL,
        changed_fields TEXT NOT NULL,
        reason TEXT NOT NULL,
        context_packet_id TEXT,
        context_packet_sha256 TEXT,
        next_temporal_check_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO operator_temporal_effects
         (workorder_attempt_id, task_id, generation_key, occurrence_key, outcome,
          before_revision, after_revision, changed_fields, reason,
          context_packet_id, context_packet_sha256, next_temporal_check_at, created_at)
       VALUES (?, ?, ?, ?, 'final_no_update', 1, 2, '[]', 'legacy receipt',
               'ctxp_legacy_shape', ?, NULL, ?)`
    ).run(
      generation.workOrder.id,
      task.id,
      generationKey,
      occurrenceKey,
      'b'.repeat(64),
      Date.parse('2026-07-21T15:00:00Z')
    );

    applyOperatorTaskTemporalMigration(db);
    const receipt = ledger.getTemporalEffect(generation.workOrder.id)!;

    expect(receipt).toMatchObject({
      attestationVersion: 0,
      contextPacketId: 'ctxp_legacy_shape',
      contextPacketSha256: 'b'.repeat(64),
    });
    expect(
      temporalReceiptInvariantError(receipt, {
        attemptId: generation.workOrder.id,
        taskId: task.id,
        generationKey,
        occurrenceKey,
      })
    ).toMatch(/legacy.*quarantined/i);
    db.close();
  });
});
