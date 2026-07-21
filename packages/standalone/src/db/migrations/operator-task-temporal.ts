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
    DROP INDEX IF EXISTS idx_operator_temporal_generations_task_occurrence;
    DROP INDEX IF EXISTS idx_operator_tasks_temporal_candidates;

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
      attestation_version INTEGER NOT NULL DEFAULT 0 CHECK (attestation_version IN (0, 1)),
      context_packet_id TEXT NOT NULL,
      context_packet_sha256 TEXT NOT NULL,
      next_temporal_check_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operator_tasks_temporal_scan_id
      ON operator_tasks(id)
      WHERE kind = 'owner' AND status IN ('pending','in_progress','review','blocked')
        AND (due_at IS NOT NULL OR deadline IS NOT NULL OR next_temporal_check_at IS NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_operator_tasks_temporal_open_event
      ON operator_tasks(source_event_id, id)
      WHERE kind = 'system' AND source_channel = 'workorder:temporal'
        AND status IN ('pending','in_progress');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_temporal_generations_identity
      ON operator_temporal_generations(task_id, temporal_epoch, occurrence_key, check_at);
    CREATE INDEX IF NOT EXISTS idx_operator_temporal_generations_active
      ON operator_temporal_generations(generation_key, last_workorder_id)
      WHERE disposition = 'active' AND last_workorder_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_operator_temporal_generations_workorder
      ON operator_temporal_generations(last_workorder_id);
    CREATE INDEX IF NOT EXISTS idx_operator_temporal_effects_task_occurrence
      ON operator_temporal_effects(task_id, occurrence_key, created_at);

    CREATE TRIGGER IF NOT EXISTS trg_operator_tasks_legacy_deadline_write
    AFTER UPDATE OF deadline ON operator_tasks
    WHEN NEW.kind = 'owner'
      AND NEW.deadline IS NOT OLD.deadline
      AND NEW.due_at IS OLD.due_at
      AND NEW.temporal_epoch = OLD.temporal_epoch
    BEGIN
      UPDATE operator_tasks
      SET due_at = NULL,
          deadline_offset_minutes = NULL,
          revision = OLD.revision + 1,
          temporal_epoch = OLD.temporal_epoch + 1,
          temporal_reconciled_occurrence_key = NULL,
          last_temporal_checked_at = NULL,
          next_temporal_check_at = NULL,
          last_temporal_attempt_id = NULL
      WHERE id = NEW.id;
      UPDATE operator_temporal_generations
      SET disposition = 'superseded', reason = 'legacy-deadline-write', updated_at = NEW.updated_at
      WHERE task_id = NEW.id AND disposition = 'active';
      UPDATE operator_tasks
      SET status = 'cancelled', latest_event = 'legacy-deadline-write', updated_at = NEW.updated_at
      WHERE kind = 'system' AND source_channel = 'workorder:temporal'
        AND status IN ('pending','in_progress')
        AND source_event_id IN (
          SELECT generation_key FROM operator_temporal_generations WHERE task_id = NEW.id
        );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_operator_tasks_legacy_status_write
    AFTER UPDATE OF status ON operator_tasks
    WHEN NEW.kind = 'owner'
      AND NEW.status IS NOT OLD.status
      AND NEW.revision = OLD.revision
    BEGIN
      UPDATE operator_tasks
      SET revision = OLD.revision + 1,
          temporal_epoch = CASE
            WHEN OLD.status IN ('done','cancelled')
              AND NEW.status NOT IN ('done','cancelled')
            THEN OLD.temporal_epoch + 1
            ELSE OLD.temporal_epoch
          END,
          temporal_reconciled_occurrence_key = CASE
            WHEN OLD.status IN ('done','cancelled')
              AND NEW.status NOT IN ('done','cancelled')
            THEN NULL
            ELSE NEW.temporal_reconciled_occurrence_key
          END,
          last_temporal_checked_at = CASE
            WHEN OLD.status IN ('done','cancelled')
              AND NEW.status NOT IN ('done','cancelled')
            THEN NULL
            ELSE NEW.last_temporal_checked_at
          END,
          next_temporal_check_at = CASE
            WHEN OLD.status IN ('done','cancelled')
              AND NEW.status NOT IN ('done','cancelled')
            THEN NULL
            ELSE NEW.next_temporal_check_at
          END,
          last_temporal_attempt_id = CASE
            WHEN OLD.status IN ('done','cancelled')
              AND NEW.status NOT IN ('done','cancelled')
            THEN NULL
            ELSE NEW.last_temporal_attempt_id
          END
      WHERE id = NEW.id;
      UPDATE operator_tasks
      SET status = 'cancelled',
          latest_event = CASE
            WHEN NEW.status IN ('done','cancelled') THEN 'legacy-owner-task-closed'
            ELSE 'legacy-owner-task-reopened'
          END,
          updated_at = NEW.updated_at
      WHERE kind = 'system' AND source_channel = 'workorder:temporal'
        AND status IN ('pending','in_progress')
        AND source_event_id IN (
          SELECT generation_key FROM operator_temporal_generations
          WHERE task_id = NEW.id AND disposition = 'active'
        )
        AND (
          (OLD.status IN ('done','cancelled') AND NEW.status NOT IN ('done','cancelled'))
          OR
          (OLD.status NOT IN ('done','cancelled') AND NEW.status IN ('done','cancelled'))
        );
      UPDATE operator_temporal_generations
      SET disposition = 'superseded',
          reason = CASE
            WHEN NEW.status IN ('done','cancelled') THEN 'legacy-owner-task-closed'
            ELSE 'legacy-owner-task-reopened'
          END,
          updated_at = NEW.updated_at
      WHERE task_id = NEW.id AND disposition = 'active'
        AND (
          (OLD.status IN ('done','cancelled') AND NEW.status NOT IN ('done','cancelled'))
          OR
          (OLD.status NOT IN ('done','cancelled') AND NEW.status IN ('done','cancelled'))
        );
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

  const effectColumns = new Set(
    (
      db.prepare('PRAGMA table_info(operator_temporal_effects)').all() as Array<{ name: string }>
    ).map((column) => column.name)
  );
  if (!effectColumns.has('context_packet_id')) {
    db.exec(`ALTER TABLE operator_temporal_effects ADD COLUMN context_packet_id TEXT`);
  }
  if (!effectColumns.has('context_packet_sha256')) {
    db.exec(`ALTER TABLE operator_temporal_effects ADD COLUMN context_packet_sha256 TEXT`);
  }
  if (!effectColumns.has('attestation_version')) {
    db.exec(
      `ALTER TABLE operator_temporal_effects
       ADD COLUMN attestation_version INTEGER NOT NULL DEFAULT 0
       CHECK (attestation_version IN (0, 1))`
    );
  }
}
