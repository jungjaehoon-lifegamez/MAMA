CREATE TABLE IF NOT EXISTS operator_memory_commit_intents (
  intent_id TEXT PRIMARY KEY,
  cursor_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0),
  memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%'),
  memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted')),
  claim_token TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_operator_memory_commit_intents_cursor_created
  ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_memory_commit_intents_idempotency_key
  ON operator_memory_commit_intents(idempotency_key);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (40, 'Create operator memory commit intents');
