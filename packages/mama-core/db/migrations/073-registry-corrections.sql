-- Atomic, scoped identity corrections. Migration 069 remains the authority for aliases and
-- scope bindings; correction history extends that schema without rewriting it.
CREATE TABLE IF NOT EXISTS registry_identity_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
INSERT OR IGNORE INTO registry_identity_state (singleton, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS registry_corrections (
  command_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('add_alias', 'merge', 'split', 'assign_refs')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  committed_revision INTEGER NOT NULL UNIQUE CHECK (committed_revision > expected_revision),
  principal_id TEXT,
  agent_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('trusted', 'legacy_unattributed')),
  payload_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (
    (origin = 'trusted' AND principal_id IS NOT NULL AND length(trim(principal_id)) > 0
      AND agent_id IS NOT NULL AND length(trim(agent_id)) > 0)
    OR (origin = 'legacy_unattributed' AND principal_id IS NULL AND agent_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS registry_ref_assignments (
  command_id TEXT NOT NULL REFERENCES registry_corrections(command_id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (endpoint IN ('from', 'to')),
  original_kind TEXT NOT NULL,
  original_id TEXT NOT NULL,
  resolved_node_id TEXT REFERENCES registry_nodes(id),
  committed_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (command_id, edge_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_registry_ref_assignments_current
  ON registry_ref_assignments(edge_id, endpoint, committed_revision DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (73, 'Atomic scoped registry correction history');
