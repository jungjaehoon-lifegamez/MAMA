import type { SQLiteDatabase } from '../../sqlite.js';

/** Additive review evidence columns; legacy review rows intentionally remain null. */
export function applyOperatorTaskReviewLifecycleMigration(db: SQLiteDatabase): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(operator_tasks)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!columns.has('review_started_at')) {
    db.exec('ALTER TABLE operator_tasks ADD COLUMN review_started_at INTEGER');
  }
  if (!columns.has('review_anchor_event_id')) {
    db.exec('ALTER TABLE operator_tasks ADD COLUMN review_anchor_event_id TEXT');
  }
}
