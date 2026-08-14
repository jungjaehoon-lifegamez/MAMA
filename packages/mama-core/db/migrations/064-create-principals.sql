CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'member')),
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'offboarded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_at_most_one_owner
  ON principals(kind)
  WHERE kind = 'owner' AND status = 'active';

CREATE TABLE IF NOT EXISTS external_identities (
  connector TEXT NOT NULL,
  namespace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (connector, namespace, external_id)
);

CREATE INDEX IF NOT EXISTS idx_external_identities_principal
  ON external_identities(principal_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (64, 'Create principals and external_identities for member registry');
