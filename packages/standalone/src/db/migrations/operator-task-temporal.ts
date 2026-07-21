import type { SQLiteDatabase } from '../../sqlite.js';

const TEMPORAL_TASK_COLUMNS = [
  ['due_at', 'INTEGER'],
  ['deadline_offset_minutes', 'INTEGER CHECK (deadline_offset_minutes BETWEEN -840 AND 840)'],
  ['revision', 'INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)'],
  ['temporal_epoch', 'INTEGER NOT NULL DEFAULT 0 CHECK (temporal_epoch >= 0)'],
  ['temporal_reconciled_occurrence_key', 'TEXT'],
  ['last_temporal_checked_at', 'INTEGER'],
  ['next_temporal_check_at', 'INTEGER'],
  ['last_temporal_attempt_id', 'INTEGER'],
] as const;

/**
 * Adds temporal task storage inside TaskLedger's existing BEGIN IMMEDIATE.
 * This function deliberately owns no transaction so it cannot commit a
 * partially upgraded legacy copy-swap.
 */
export function applyOperatorTaskTemporalMigration(db: SQLiteDatabase): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(operator_tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  for (const [name, definition] of TEMPORAL_TASK_COLUMNS) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE operator_tasks ADD COLUMN ${name} ${definition}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_temporal_generations (
      generation_key TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      temporal_epoch INTEGER NOT NULL CHECK (temporal_epoch >= 0),
      occurrence_key TEXT NOT NULL,
      check_at INTEGER NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'active'
        CHECK (disposition IN ('active','resolved','final_no_update','deferred','exhausted','superseded')),
      last_workorder_id INTEGER REFERENCES operator_tasks(id),
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operator_temporal_effects (
      workorder_attempt_id INTEGER PRIMARY KEY REFERENCES operator_tasks(id),
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      generation_key TEXT NOT NULL REFERENCES operator_temporal_generations(generation_key),
      occurrence_key TEXT NOT NULL,
      outcome TEXT NOT NULL
        CHECK (outcome IN ('resolved','final_no_update','deferred')),
      before_revision INTEGER NOT NULL CHECK (before_revision >= 0),
      after_revision INTEGER NOT NULL CHECK (after_revision >= 0),
      changed_fields TEXT NOT NULL,
      reason TEXT NOT NULL,
      next_temporal_check_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operator_tasks_temporal_candidates
      ON operator_tasks(next_temporal_check_at, due_at, deadline, id)
      WHERE kind = 'owner' AND status IN ('pending','in_progress','review','blocked');
    CREATE INDEX IF NOT EXISTS idx_operator_temporal_generations_task_occurrence
      ON operator_temporal_generations(task_id, temporal_epoch, occurrence_key, check_at);
    CREATE INDEX IF NOT EXISTS idx_operator_temporal_generations_workorder
      ON operator_temporal_generations(last_workorder_id);
    CREATE INDEX IF NOT EXISTS idx_operator_temporal_effects_task_occurrence
      ON operator_temporal_effects(task_id, occurrence_key, created_at);
  `);
}
