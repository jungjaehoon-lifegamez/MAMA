CREATE TABLE IF NOT EXISTS memory_truth (
  memory_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  truth_status TEXT NOT NULL,
  effective_summary TEXT NOT NULL,
  effective_details TEXT NOT NULL,
  trust_score REAL NOT NULL,
  scope_refs TEXT NOT NULL,
  supporting_event_ids TEXT NOT NULL,
  superseded_by TEXT,
  contradicted_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_memory_truth_topic_updated_at
  ON memory_truth(topic, updated_at DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (21, 'Create memory truth projection table');
