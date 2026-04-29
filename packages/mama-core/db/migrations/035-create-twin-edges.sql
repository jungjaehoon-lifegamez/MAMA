CREATE TABLE IF NOT EXISTS twin_edges (
  edge_id TEXT PRIMARY KEY,
  edge_type TEXT NOT NULL CHECK (
    edge_type IN (
      'supersedes',
      'builds_on',
      'debates',
      'synthesizes',
      'mentions',
      'derived_from',
      'case_member',
      'alias_of',
      'next_action_for',
      'blocks'
    )
  ),
  subject_kind TEXT NOT NULL CHECK (
    subject_kind IN ('memory', 'case', 'entity', 'report', 'edge')
  ),
  subject_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (
    object_kind IN ('memory', 'case', 'entity', 'report', 'edge', 'raw')
  ),
  object_id TEXT NOT NULL,
  relation_attrs_json TEXT,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source TEXT NOT NULL CHECK (source IN ('agent', 'human', 'code')),
  agent_id TEXT,
  model_run_id TEXT,
  envelope_hash TEXT,
  human_actor_id TEXT,
  human_actor_role TEXT,
  authority_scope_json TEXT,
  reason_classification TEXT,
  reason_text TEXT,
  evidence_refs_json TEXT,
  request_idempotency_key TEXT,
  edge_idempotency_key TEXT,
  content_hash BLOB NOT NULL CHECK(length(content_hash)=32),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twin_edges_subject
  ON twin_edges(subject_kind, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_twin_edges_object
  ON twin_edges(object_kind, object_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_twin_edges_model_run_id
  ON twin_edges(model_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_twin_edges_request_idempotency
  ON twin_edges(model_run_id, request_idempotency_key, created_at DESC)
  WHERE model_run_id IS NOT NULL
    AND request_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_twin_edges_model_run_edge_idempotency
  ON twin_edges(model_run_id, edge_idempotency_key)
  WHERE model_run_id IS NOT NULL
    AND edge_idempotency_key IS NOT NULL;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (35, 'Create first-class twin edge ledger');
