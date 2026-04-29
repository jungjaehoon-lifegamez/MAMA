import type { SQLiteDatabase } from '../../sqlite.js';

export function applyAgentStoreTablesMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL,
      version      INTEGER NOT NULL,
      snapshot     TEXT NOT NULL,
      persona_text TEXT,
      change_note  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, version)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      agent_version   INTEGER NOT NULL,
      period_start    TEXT NOT NULL,
      period_end      TEXT NOT NULL,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      tool_calls      INTEGER DEFAULT 0,
      delegations     INTEGER DEFAULT 0,
      errors          INTEGER DEFAULT 0,
      avg_response_ms REAL DEFAULT 0,
      response_ms_sum REAL DEFAULT 0,
      response_count  INTEGER DEFAULT 0,
      UNIQUE(agent_id, agent_version, period_start)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent_id, agent_version)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id         TEXT NOT NULL,
      agent_version    INTEGER NOT NULL,
      type             TEXT NOT NULL,
      input_summary    TEXT,
      output_summary   TEXT,
      tokens_used      INTEGER DEFAULT 0,
      tools_called     TEXT,
      duration_ms      INTEGER DEFAULT 0,
      score            REAL,
      details          TEXT,
      error_message    TEXT,
      run_id           TEXT,
      execution_status TEXT,
      trigger_reason   TEXT,
      envelope_hash    TEXT,
      gateway_call_id  TEXT,
      requested_scopes TEXT,
      envelope_scopes_snapshot TEXT,
      scope_mismatch   INTEGER DEFAULT 0 CHECK (scope_mismatch IN (0, 1)),
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity(agent_id, created_at)`
  );
}
