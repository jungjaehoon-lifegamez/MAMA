import type { SQLiteDatabase } from '../../sqlite.js';

/**
 * Additive classification columns (owner policy: records and tasks are separate).
 *
 * `completion_criteria` is what makes a row a TASK rather than a record: a
 * concrete, finite condition under which it is finished. `resolution_kind` is the
 * SEMANTIC terminal reason, so a closed row can say whether the work completed or
 * whether it was never a task at all.
 *
 * Both are nullable on purpose: rows that predate this migration stay readable
 * with null, and internal/system seeding remains backward compatible. No
 * destructive rebuild - neither column carries an inline CHECK.
 */
export function applyOperatorTaskClassificationMigration(db: SQLiteDatabase): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(operator_tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('completion_criteria')) {
    db.exec('ALTER TABLE operator_tasks ADD COLUMN completion_criteria TEXT');
  }
  if (!columns.has('resolution_kind')) {
    db.exec('ALTER TABLE operator_tasks ADD COLUMN resolution_kind TEXT');
  }
}
