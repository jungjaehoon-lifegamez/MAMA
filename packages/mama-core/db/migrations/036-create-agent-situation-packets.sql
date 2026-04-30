CREATE TABLE IF NOT EXISTS agent_situation_packets (
  packet_id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
  range_end_ms INTEGER NOT NULL CHECK (range_end_ms >= range_start_ms),
  focus_json TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  envelope_effective_filters_json TEXT NOT NULL,
  envelope_effective_filters_hash TEXT NOT NULL,
  ranking_policy_version TEXT NOT NULL,
  generated_at INTEGER NOT NULL CHECK (generated_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= generated_at),
  ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds > 0),
  freshness_json TEXT NOT NULL,
  source_coverage_json TEXT NOT NULL,
  briefing_json TEXT NOT NULL,
  ranked_items_json TEXT NOT NULL,
  top_memory_refs_json TEXT NOT NULL,
  pending_human_questions_json TEXT NOT NULL,
  entity_clusters_json TEXT NOT NULL,
  recommended_next_tools_json TEXT NOT NULL,
  generated_from_slice_ids_json TEXT NOT NULL DEFAULT '[]',
  caveats_json TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model_run_id TEXT NOT NULL,
  input_snapshot_ref TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  project_id TEXT NOT NULL,
  memory_scope_kind TEXT NOT NULL,
  memory_scope_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_situation_cache_fresh
  ON agent_situation_packets(cache_key, ranking_policy_version, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_situation_envelope
  ON agent_situation_packets(envelope_hash, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_situation_model_run
  ON agent_situation_packets(model_run_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_situation_scope
  ON agent_situation_packets(tenant_id, project_id, memory_scope_kind, memory_scope_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS agent_situation_refresh_leases (
  cache_key TEXT PRIMARY KEY,
  ranking_policy_version TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_situation_leases_expiry
  ON agent_situation_refresh_leases(lease_expires_at);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (36, 'Create agent situation packet cache');
