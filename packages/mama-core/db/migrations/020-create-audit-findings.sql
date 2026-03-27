CREATE TABLE IF NOT EXISTS audit_findings (
  finding_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  affected_memory_ids TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_audit_findings_status_created_at
  ON audit_findings(status, created_at DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (20, 'Create audit findings table');
