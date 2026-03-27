CREATE TABLE IF NOT EXISTS memory_scopes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('global', 'user', 'channel', 'project')),
  external_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  UNIQUE(kind, external_id)
);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (17, 'Create memory scopes table');
