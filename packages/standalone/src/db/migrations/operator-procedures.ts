import type { SQLiteDatabase } from '../../sqlite.js';

/** TG-03/TG-05/TG-06: additive canonical revisions in the existing operator database. */
export function applyOperatorProceduresMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_procedures (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','retired')),
      owner_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      channel_ids_json TEXT,
      PRIMARY KEY(owner_scope, project_id, id)
    );
    CREATE INDEX IF NOT EXISTS operator_procedures_scope ON operator_procedures(owner_scope, project_id);
    CREATE TABLE IF NOT EXISTS operator_procedure_revisions (
      procedure_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      owner_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      correction_id TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY(owner_scope, project_id, procedure_id, revision),
      UNIQUE(owner_scope, project_id, correction_id)
    );
    CREATE TRIGGER IF NOT EXISTS operator_procedure_revision_no_update
      BEFORE UPDATE ON operator_procedure_revisions BEGIN SELECT RAISE(ABORT, 'procedure revision immutable'); END;
    CREATE TRIGGER IF NOT EXISTS operator_procedure_revision_no_delete
      BEFORE DELETE ON operator_procedure_revisions BEGIN SELECT RAISE(ABORT, 'procedure revision immutable'); END;
    CREATE TABLE IF NOT EXISTS operator_procedure_projections (
      owner_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      procedure_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      published_hash TEXT NOT NULL,
      PRIMARY KEY(owner_scope, project_id, procedure_id, revision)
    );
    CREATE TABLE IF NOT EXISTS operator_trigger_procedure_bindings (
      trigger_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      procedure_id TEXT NOT NULL,
      procedure_revision INTEGER NOT NULL,
      scope_key TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      PRIMARY KEY(trigger_id, owner_scope, project_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS operator_procedure_outcomes (
      owner_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      procedure_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      PRIMARY KEY(owner_scope, project_id, procedure_id, receipt_id)
    );
  `);
}
