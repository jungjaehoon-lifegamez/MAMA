CREATE TABLE IF NOT EXISTS memory_scope_bindings (
  memory_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (memory_id, scope_id),
  FOREIGN KEY (memory_id) REFERENCES decisions(id) ON DELETE CASCADE,
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_scope_bindings_scope_id
  ON memory_scope_bindings(scope_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (18, 'Create memory scope bindings table');
