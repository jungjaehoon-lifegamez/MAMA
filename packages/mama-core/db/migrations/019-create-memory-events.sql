CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  source_turn_id TEXT,
  memory_id TEXT,
  topic TEXT,
  scope_refs TEXT NOT NULL,
  evidence_refs TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_topic_created_at
  ON memory_events(topic, created_at DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (19, 'Create memory events table');
