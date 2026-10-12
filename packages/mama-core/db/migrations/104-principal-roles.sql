CREATE TABLE IF NOT EXISTS principal_roles (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, role)
);

CREATE INDEX IF NOT EXISTS idx_principal_roles_role ON principal_roles(role, principal_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (104, 'Consumer-defined roles on member principals');
