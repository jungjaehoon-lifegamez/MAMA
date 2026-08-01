import type { SQLiteDatabase } from '../../sqlite.js';

/**
 * External lifecycle storage is installed inside TaskLedger's migration
 * transaction. It intentionally does not infer bindings from legacy task
 * provenance: only a receipted, candidate-bound decision can create one.
 */
export function applyOperatorTaskExternalLifecycleMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_external_task_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      connector TEXT NOT NULL CHECK (connector = 'kagemusha'),
      source_type TEXT NOT NULL CHECK (source_type = 'kanban_card'),
      external_source_id TEXT NOT NULL,
      last_observation_seq INTEGER NOT NULL CHECK (last_observation_seq >= 1),
      created_by_attempt_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_external_binding_active_task
      ON operator_external_task_bindings(task_id) WHERE active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_external_binding_active_external
      ON operator_external_task_bindings(connector, source_type, external_source_id) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS operator_external_binding_receipts (
      candidate_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('bind','decline')),
      workorder_attempt_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      event_id TEXT NOT NULL,
      connector TEXT NOT NULL CHECK (connector = 'kagemusha'),
      source_type TEXT NOT NULL CHECK (source_type = 'kanban_card'),
      external_source_id TEXT NOT NULL,
      channel_partition TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      source_timestamp_ms INTEGER NOT NULL,
      operator_ingest_seq INTEGER NOT NULL CHECK (operator_ingest_seq >= 1),
      operator_observation_seq INTEGER NOT NULL CHECK (operator_observation_seq >= 1),
      task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
      outcome TEXT NOT NULL CHECK (outcome IN ('bound','declined','superseded')),
      reason TEXT NOT NULL,
      binding_id INTEGER REFERENCES operator_external_task_bindings(id),
      origin_run_id TEXT,
      origin_cause_event_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operator_external_binding_receipts_attempt
      ON operator_external_binding_receipts(workorder_attempt_id, candidate_id);

    CREATE TABLE IF NOT EXISTS operator_external_lifecycle_receipts (
      candidate_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('apply','retain')),
      workorder_attempt_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      event_id TEXT NOT NULL,
      connector TEXT NOT NULL CHECK (connector = 'kagemusha'),
      source_type TEXT NOT NULL CHECK (source_type = 'kanban_card'),
      external_source_id TEXT NOT NULL,
      channel_partition TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      source_timestamp_ms INTEGER NOT NULL,
      operator_ingest_seq INTEGER NOT NULL CHECK (operator_ingest_seq >= 1),
      operator_observation_seq INTEGER NOT NULL CHECK (operator_observation_seq >= 1),
      binding_id INTEGER NOT NULL REFERENCES operator_external_task_bindings(id),
      binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
      task_revision_before INTEGER NOT NULL CHECK (task_revision_before >= 1),
      task_revision_after INTEGER NOT NULL CHECK (task_revision_after >= 1),
      outcome TEXT NOT NULL CHECK (outcome IN ('applied','retained','superseded')),
      reason TEXT NOT NULL,
      origin_run_id TEXT,
      origin_cause_event_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operator_external_lifecycle_receipts_attempt
      ON operator_external_lifecycle_receipts(workorder_attempt_id, candidate_id);
  `);
}
