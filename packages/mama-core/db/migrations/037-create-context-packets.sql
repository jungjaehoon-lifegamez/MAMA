CREATE TABLE IF NOT EXISTS context_packets (
  packet_id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  model_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  input_snapshot_ref TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  project_id TEXT NOT NULL,
  memory_scope_kind TEXT NOT NULL CHECK (memory_scope_kind IN ('global', 'user', 'channel', 'project')),
  memory_scope_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_context_packets_model_run
  ON context_packets(model_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_packets_envelope
  ON context_packets(envelope_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_packets_scope
  ON context_packets(tenant_id, project_id, memory_scope_kind, memory_scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_packets_scope_hash
  ON context_packets(scope_hash, created_at DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (37, 'Create context packet append-only store');
