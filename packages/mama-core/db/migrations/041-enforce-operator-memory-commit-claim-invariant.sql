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

DROP TABLE IF EXISTS operator_memory_commit_intents_v041;

CREATE TABLE operator_memory_commit_intents_v041 (
  intent_id TEXT PRIMARY KEY,
  cursor_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0),
  memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%'),
  memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted')),
  claim_token TEXT CHECK (
    (status = 'saving' AND claim_token IS NOT NULL) OR
    (status != 'saving' AND claim_token IS NULL)
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

INSERT INTO operator_memory_commit_intents_v041 (
  intent_id,
  cursor_name,
  idempotency_key,
  expected_memory_count,
  memory_payload_hash,
  memory_ids_json,
  source_refs_json,
  status,
  claim_token,
  created_at_ms,
  updated_at_ms
)
SELECT
  intent_id,
  cursor_name,
  idempotency_key,
  expected_memory_count,
  memory_payload_hash,
  memory_ids_json,
  source_refs_json,
  CASE
    WHEN status = 'saving' AND claim_token IS NULL THEN 'pending'
    ELSE status
  END,
  CASE
    WHEN status = 'saving' AND claim_token IS NOT NULL THEN claim_token
    ELSE NULL
  END,
  created_at_ms,
  updated_at_ms
FROM operator_memory_commit_intents;

DROP TABLE operator_memory_commit_intents;
ALTER TABLE operator_memory_commit_intents_v041 RENAME TO operator_memory_commit_intents;

CREATE INDEX IF NOT EXISTS idx_operator_memory_commit_intents_cursor_created
  ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (41, 'Enforce operator memory commit claim invariant');
