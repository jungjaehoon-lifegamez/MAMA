CREATE TABLE IF NOT EXISTS channel_summaries (
  channel_key TEXT PRIMARY KEY,
  summary_markdown TEXT NOT NULL,
  delta_hash TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (22, 'Create channel summaries table');
