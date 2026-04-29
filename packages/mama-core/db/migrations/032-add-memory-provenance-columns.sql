ALTER TABLE decisions ADD COLUMN agent_id TEXT;
ALTER TABLE decisions ADD COLUMN model_run_id TEXT;
ALTER TABLE decisions ADD COLUMN envelope_hash TEXT;
ALTER TABLE decisions ADD COLUMN gateway_call_id TEXT;
ALTER TABLE decisions ADD COLUMN source_refs_json TEXT;
ALTER TABLE decisions ADD COLUMN provenance_json TEXT;

CREATE INDEX IF NOT EXISTS idx_decisions_envelope_hash
  ON decisions(envelope_hash);

CREATE INDEX IF NOT EXISTS idx_decisions_model_run_id
  ON decisions(model_run_id);

CREATE INDEX IF NOT EXISTS idx_decisions_gateway_call_id
  ON decisions(gateway_call_id);

CREATE INDEX IF NOT EXISTS idx_memory_events_memory_created
  ON memory_events(memory_id, created_at DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (32, 'Add nullable memory provenance columns');
