CREATE TABLE IF NOT EXISTS vnext_operator_cursors (
  cursor_name TEXT PRIMARY KEY,
  last_change_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_change_seq >= 0),
  last_idempotency_key TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS vnext_operator_commits (
  commit_id TEXT PRIMARY KEY,
  cursor_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  first_change_seq INTEGER NOT NULL CHECK (first_change_seq >= 0),
  last_change_seq INTEGER NOT NULL CHECK (last_change_seq >= first_change_seq),
  status TEXT NOT NULL CHECK (status IN ('changed', 'no_update')),
  changed_refs_json TEXT NOT NULL CHECK (json_valid(changed_refs_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (cursor_name) REFERENCES vnext_operator_cursors(cursor_name)
);

CREATE INDEX IF NOT EXISTS idx_vnext_operator_commits_cursor_seq
  ON vnext_operator_commits(cursor_name, last_change_seq);

CREATE TABLE IF NOT EXISTS operator_no_updates (
  no_update_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_operator_no_updates_scope_created
  ON operator_no_updates(scope_key, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS worker_proposals (
  proposal_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  accepted_at_ms INTEGER CHECK (
    (status = 'proposed' AND accepted_at_ms IS NULL) OR
    (status = 'accepted' AND accepted_at_ms IS NOT NULL AND accepted_at_ms >= created_at_ms) OR
    (status = 'rejected' AND accepted_at_ms IS NULL) OR
    (status = 'superseded' AND (accepted_at_ms IS NULL OR accepted_at_ms >= created_at_ms))
  )
);

CREATE INDEX IF NOT EXISTS idx_worker_proposals_status_kind
  ON worker_proposals(status, kind, created_at_ms);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (38, 'Create vNext operator contracts');
