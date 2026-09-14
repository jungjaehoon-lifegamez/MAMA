import type { SQLiteDatabase } from '../../sqlite.js';

/**
 * The exact-deadline and revision columns on `operator_tasks`, and the
 * retirement of the temporal reconciliation storage that used to share this
 * migration.
 *
 * What stays is what other readers need: `due_at` and `deadline_offset_minutes`
 * carry an exact deadline next to the date-only `deadline`, and `revision` is
 * the optimistic-concurrency counter every receipted write checks.
 *
 * What goes is the reconcile machinery's own state - two tables, five marker
 * columns, and the indexes and trigger clauses that maintained them. Nothing
 * reads them any more, and a column that no longer has a reader is worse than
 * an absent one: it keeps answering, with whatever it last held.
 *
 * Column drops are ordered against SQLite's restrictions: a column named by a
 * partial index or a trigger cannot be dropped, so the indexes and triggers go
 * first and the simplified triggers are created afterwards.
 */
const DEADLINE_TASK_COLUMNS = [
  ['due_at', 'INTEGER'],
  ['deadline_offset_minutes', 'INTEGER CHECK (deadline_offset_minutes BETWEEN -840 AND 840)'],
  ['revision', 'INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)'],
] as const;

/** The reconcile markers, dropped from any database that still carries them. */
const RETIRED_TEMPORAL_COLUMNS = [
  'temporal_epoch',
  'temporal_reconciled_occurrence_key',
  'last_temporal_checked_at',
  'next_temporal_check_at',
  'last_temporal_attempt_id',
] as const;

/**
 * Adds deadline task storage inside TaskLedger's existing BEGIN IMMEDIATE.
 * This function deliberately owns no transaction so it cannot commit a
 * partially upgraded legacy copy-swap.
 */
export function applyOperatorTaskDeadlineMigration(db: SQLiteDatabase): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(operator_tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  for (const [name, definition] of DEADLINE_TASK_COLUMNS) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE operator_tasks ADD COLUMN ${name} ${definition}`);
    }
  }

  // Triggers and indexes first: both name the columns dropped below, and a
  // named column cannot be dropped. The triggers are recreated at the end
  // without their temporal clauses.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_operator_tasks_legacy_deadline_write;
    DROP TRIGGER IF EXISTS trg_operator_tasks_legacy_status_write;
    DROP TRIGGER IF EXISTS trg_operator_tasks_legacy_content_write;

    DROP INDEX IF EXISTS idx_operator_temporal_generations_task_occurrence;
    DROP INDEX IF EXISTS idx_operator_tasks_temporal_candidates;
    DROP INDEX IF EXISTS idx_operator_tasks_temporal_scan_id;
    DROP INDEX IF EXISTS idx_operator_tasks_temporal_open_event;
    DROP INDEX IF EXISTS idx_operator_temporal_generations_identity;
    DROP INDEX IF EXISTS idx_operator_temporal_generations_active;
    DROP INDEX IF EXISTS idx_operator_temporal_generations_workorder;
    DROP INDEX IF EXISTS idx_operator_temporal_effects_task_occurrence;
  `);

  // A temporal system row left open would be claimed by the serial consumer,
  // which no longer has a turn contract for it. Close it with a named reason
  // rather than leaving the queue holding work nothing can run.
  db.prepare(
    `UPDATE operator_tasks
        SET status = 'cancelled', latest_event = 'temporal-reconciliation-retired'
      WHERE kind = 'system' AND source_channel = 'workorder:temporal'
        AND status IN ('pending','in_progress')`
  ).run();

  // Effects references generations, so it goes first.
  db.exec(`
    DROP TABLE IF EXISTS operator_temporal_effects;
    DROP TABLE IF EXISTS operator_temporal_generations;
  `);

  for (const name of RETIRED_TEMPORAL_COLUMNS) {
    if (columns.has(name)) {
      db.exec(`ALTER TABLE operator_tasks DROP COLUMN ${name}`);
    }
  }

  // A direct write that bypasses the ledger still has to move `revision`, or
  // the next receipted write would accept a stale expected_revision. A legacy
  // deadline write also clears the exact-time pair the date-only column
  // contradicts.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_operator_tasks_legacy_deadline_write
    AFTER UPDATE OF deadline ON operator_tasks
    WHEN NEW.kind = 'owner'
      AND NEW.deadline IS NOT OLD.deadline
      AND NEW.due_at IS OLD.due_at
      AND NEW.revision = OLD.revision
    BEGIN
      UPDATE operator_tasks
      SET due_at = NULL,
          deadline_offset_minutes = NULL,
          revision = OLD.revision + 1
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_operator_tasks_legacy_status_write
    AFTER UPDATE OF status ON operator_tasks
    WHEN NEW.kind = 'owner'
      AND NEW.status IS NOT OLD.status
      AND NEW.revision = OLD.revision
    BEGIN
      UPDATE operator_tasks SET revision = OLD.revision + 1 WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_operator_tasks_legacy_content_write
    AFTER UPDATE OF title, priority, assignee, latest_event, confirmed ON operator_tasks
    WHEN NEW.kind = 'owner'
      AND NEW.revision = OLD.revision
      AND (
        NEW.title IS NOT OLD.title
        OR NEW.priority IS NOT OLD.priority
        OR NEW.assignee IS NOT OLD.assignee
        OR NEW.latest_event IS NOT OLD.latest_event
        OR NEW.confirmed IS NOT OLD.confirmed
      )
    BEGIN
      UPDATE operator_tasks SET revision = OLD.revision + 1 WHERE id = NEW.id;
    END;
  `);
}
