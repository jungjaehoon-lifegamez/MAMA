CREATE TABLE IF NOT EXISTS channel_summary_state (
  channel_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (23, 'Create channel summary state table');
