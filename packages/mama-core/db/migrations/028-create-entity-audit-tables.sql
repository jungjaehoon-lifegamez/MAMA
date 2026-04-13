CREATE TABLE IF NOT EXISTS entity_audit_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'timeout')),
  baseline_run_id TEXT,
  classification TEXT CHECK (classification IN ('improved', 'stable', 'regressed', 'inconclusive')),
  metric_summary_json TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at INTEGER,
  FOREIGN KEY (baseline_run_id) REFERENCES entity_audit_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_audit_runs_single_running
  ON entity_audit_runs(status)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_entity_audit_runs_created_at
  ON entity_audit_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS entity_audit_metrics (
  run_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  metric_meta_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (run_id, metric_name),
  FOREIGN KEY (run_id) REFERENCES entity_audit_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_audit_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  finding_kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  summary TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (run_id) REFERENCES entity_audit_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entity_audit_findings_run_id
  ON entity_audit_findings(run_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (28, 'Create entity benchmark and audit run storage');
