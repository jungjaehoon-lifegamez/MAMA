CREATE TABLE IF NOT EXISTS entity_resolution_candidates (
  id TEXT PRIMARY KEY,
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('alias_to_entity', 'entity_to_entity', 'cluster')),
  left_ref TEXT NOT NULL,
  right_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'auto_merged', 'approved', 'rejected', 'deferred')),
  score_total REAL NOT NULL DEFAULT 0,
  score_structural REAL NOT NULL DEFAULT 0,
  score_string REAL NOT NULL DEFAULT 0,
  score_context REAL NOT NULL DEFAULT 0,
  score_graph REAL NOT NULL DEFAULT 0,
  score_embedding REAL NOT NULL DEFAULT 0,
  rule_trace TEXT,
  extractor_version TEXT NOT NULL,
  embedding_model_version TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS entity_merge_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL CHECK (action_type IN ('merge', 'reject', 'defer', 'split')),
  source_entity_id TEXT,
  target_entity_id TEXT,
  candidate_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'user', 'agent')),
  actor_id TEXT,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (source_entity_id) REFERENCES entity_nodes(id) ON DELETE SET NULL,
  FOREIGN KEY (target_entity_id) REFERENCES entity_nodes(id) ON DELETE SET NULL,
  FOREIGN KEY (candidate_id) REFERENCES entity_resolution_candidates(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_candidates_status_score
  ON entity_resolution_candidates(status, score_total DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_merge_actions_candidate_id
  ON entity_merge_actions(candidate_id);
CREATE INDEX IF NOT EXISTS idx_entity_merge_actions_source_target
  ON entity_merge_actions(source_entity_id, target_entity_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (27, 'Create canonical entity review support tables');
