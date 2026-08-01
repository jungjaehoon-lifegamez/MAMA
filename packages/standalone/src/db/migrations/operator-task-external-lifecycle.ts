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

    CREATE TABLE IF NOT EXISTS operator_external_receipt_identities (
      candidate_id TEXT PRIMARY KEY,
      receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('binding','lifecycle')),
      created_at INTEGER NOT NULL
    );
  `);

  const duplicates = db
    .prepare(
      `SELECT binding.candidate_id
       FROM operator_external_binding_receipts binding
       INNER JOIN operator_external_lifecycle_receipts lifecycle
         ON lifecycle.candidate_id = binding.candidate_id
       LIMIT 1`
    )
    .all() as Array<{ candidate_id: string }>;
  if (duplicates.length > 0) {
    throw new Error(
      `external lifecycle migration found duplicate global candidate receipt '${duplicates[0]!.candidate_id}'`
    );
  }

  db.exec(`
    INSERT OR IGNORE INTO operator_external_receipt_identities
      (candidate_id, receipt_kind, created_at)
    SELECT candidate_id, 'binding', created_at
    FROM operator_external_binding_receipts;

    INSERT OR IGNORE INTO operator_external_receipt_identities
      (candidate_id, receipt_kind, created_at)
    SELECT candidate_id, 'lifecycle', created_at
    FROM operator_external_lifecycle_receipts;
  `);

  const inconsistent = db
    .prepare(
      `SELECT receipt.candidate_id
       FROM (
         SELECT candidate_id, 'binding' AS receipt_kind FROM operator_external_binding_receipts
         UNION ALL
         SELECT candidate_id, 'lifecycle' AS receipt_kind FROM operator_external_lifecycle_receipts
       ) receipt
       LEFT JOIN operator_external_receipt_identities identity
         ON identity.candidate_id = receipt.candidate_id
       WHERE identity.candidate_id IS NULL OR identity.receipt_kind <> receipt.receipt_kind
       LIMIT 1`
    )
    .all() as Array<{ candidate_id: string }>;
  if (inconsistent.length > 0) {
    throw new Error(
      `external lifecycle migration found inconsistent receipt identity '${inconsistent[0]!.candidate_id}'`
    );
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_operator_external_binding_receipts_global_identity
    BEFORE INSERT ON operator_external_binding_receipts
    BEGIN
      INSERT INTO operator_external_receipt_identities (candidate_id, receipt_kind, created_at)
      VALUES (NEW.candidate_id, 'binding', NEW.created_at);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_operator_external_lifecycle_receipts_global_identity
    BEFORE INSERT ON operator_external_lifecycle_receipts
    BEGIN
      INSERT INTO operator_external_receipt_identities (candidate_id, receipt_kind, created_at)
      VALUES (NEW.candidate_id, 'lifecycle', NEW.created_at);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_operator_external_binding_receipts_immutable_update
    BEFORE UPDATE ON operator_external_binding_receipts
    BEGIN SELECT RAISE(ABORT, 'external binding receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_operator_external_binding_receipts_immutable_delete
    BEFORE DELETE ON operator_external_binding_receipts
    BEGIN SELECT RAISE(ABORT, 'external binding receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_operator_external_lifecycle_receipts_immutable_update
    BEFORE UPDATE ON operator_external_lifecycle_receipts
    BEGIN SELECT RAISE(ABORT, 'external lifecycle receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_operator_external_lifecycle_receipts_immutable_delete
    BEFORE DELETE ON operator_external_lifecycle_receipts
    BEGIN SELECT RAISE(ABORT, 'external lifecycle receipts are immutable'); END;
  `);
}
