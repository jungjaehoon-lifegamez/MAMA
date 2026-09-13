-- Checkpoints are readable only when their explicit scope is bound. Legacy rows remain unscoped.

CREATE TABLE IF NOT EXISTS checkpoint_scope_bindings (
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE RESTRICT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (checkpoint_id, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_scope_bindings_scope
  ON checkpoint_scope_bindings(scope_id, checkpoint_id DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (76, 'Scoped checkpoint bindings');
