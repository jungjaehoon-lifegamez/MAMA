CREATE TABLE IF NOT EXISTS model_runs (
  model_run_id TEXT PRIMARY KEY,
  model_id TEXT,
  model_provider TEXT,
  prompt_version TEXT,
  tool_manifest_version TEXT,
  output_schema_version TEXT,
  agent_id TEXT,
  instance_id TEXT,
  envelope_hash TEXT,
  parent_model_run_id TEXT,
  input_snapshot_ref TEXT,
  input_refs_json TEXT,
  completion_summary TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'committed', 'failed', 'legacy')),
  error_summary TEXT,
  token_count INTEGER DEFAULT 0,
  cost_estimate REAL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_model_runs_envelope_hash
  ON model_runs(envelope_hash);

CREATE INDEX IF NOT EXISTS idx_model_runs_status_created
  ON model_runs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_runs_agent_created
  ON model_runs(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_traces (
  trace_id TEXT PRIMARY KEY,
  model_run_id TEXT NOT NULL,
  gateway_call_id TEXT,
  tool_name TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  execution_status TEXT,
  duration_ms INTEGER DEFAULT 0,
  envelope_hash TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (model_run_id) REFERENCES model_runs(model_run_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_traces_model_run_id
  ON tool_traces(model_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_traces_gateway_call_id
  ON tool_traces(gateway_call_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (33, 'Create model runs and tool traces');
