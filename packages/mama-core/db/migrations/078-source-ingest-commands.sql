-- Raw source ingestion commands. Every source.ingest command binds exactly one
-- immutable observation_versions row through command_bindings; the receipt is
-- replayed verbatim on idempotent retries so a retried ingest never duplicates.

CREATE TABLE IF NOT EXISTS source_commands (
  command_id TEXT PRIMARY KEY REFERENCES command_bindings(command_id) ON DELETE RESTRICT,
  observation_id TEXT NOT NULL REFERENCES observation_versions(observation_id) ON DELETE RESTRICT,
  event_id TEXT,
  committed_watermark INTEGER NOT NULL CHECK (committed_watermark >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_source_commands_observation
  ON source_commands(observation_id, created_at DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (78, 'Source ingest command receipts bound to observations');
