import type { SQLiteDatabase } from '../../sqlite.js';

export function applyValidationSessionTablesMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS validation_sessions (
      id                   TEXT PRIMARY KEY,
      agent_id             TEXT NOT NULL,
      agent_version        INTEGER NOT NULL,
      trigger_type         TEXT NOT NULL,
      goal                 TEXT,
      metric_profile_json  TEXT NOT NULL,
      baseline_version     INTEGER,
      baseline_session_id  TEXT,
      execution_status     TEXT NOT NULL,
      validation_outcome   TEXT NOT NULL,
      summary              TEXT,
      recommendation       TEXT,
      before_snapshot_json TEXT,
      after_snapshot_json  TEXT,
      report_json          TEXT,
      schema_version       INTEGER NOT NULL DEFAULT 1,
      requires_approval    INTEGER DEFAULT 0,
      started_at           INTEGER NOT NULL,
      ended_at             INTEGER
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_val_sessions_agent_status
     ON validation_sessions(agent_id, validation_outcome)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_val_sessions_agent_trigger
     ON validation_sessions(agent_id, trigger_type, started_at)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS validation_metrics (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      validation_session_id TEXT NOT NULL,
      name                  TEXT NOT NULL,
      value                 REAL NOT NULL,
      baseline_value        REAL,
      delta_value           REAL,
      direction             TEXT NOT NULL,
      created_at            INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_val_metrics_session
     ON validation_metrics(validation_session_id)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_validation_state (
      agent_id             TEXT NOT NULL,
      trigger_type         TEXT NOT NULL,
      approved_version     INTEGER,
      approved_session_id  TEXT,
      current_status       TEXT,
      last_validation_at   INTEGER,
      updated_at           INTEGER NOT NULL,
      PRIMARY KEY (agent_id, trigger_type)
    )
  `);
}
