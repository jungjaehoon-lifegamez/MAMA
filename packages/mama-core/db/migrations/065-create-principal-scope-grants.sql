CREATE TABLE IF NOT EXISTS principal_scope_grants (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('source', 'memory')),
  scope_kind TEXT NOT NULL CHECK (
    length(trim(scope_kind)) > 0
    AND scope_kind <> '*'
    AND (grant_kind = 'source' OR scope_kind IN ('project', 'channel', 'global'))
  ),
  scope_id TEXT NOT NULL CHECK (length(trim(scope_id)) > 0 AND scope_id <> '*'),
  granted_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_scope_grants_one_active
  ON principal_scope_grants(principal_id, grant_kind, scope_kind, scope_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_principal_scope_grants_active_listing
  ON principal_scope_grants(principal_id, created_at, grant_kind, scope_kind, scope_id)
  WHERE revoked_at IS NULL;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (65, 'Create principal scope grants for human-team access');
