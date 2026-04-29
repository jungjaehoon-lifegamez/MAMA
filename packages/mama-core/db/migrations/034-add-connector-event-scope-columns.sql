ALTER TABLE connector_event_index ADD COLUMN source_cursor TEXT;
ALTER TABLE connector_event_index ADD COLUMN tenant_id TEXT;
ALTER TABLE connector_event_index ADD COLUMN project_id TEXT;
ALTER TABLE connector_event_index ADD COLUMN memory_scope_kind TEXT;
ALTER TABLE connector_event_index ADD COLUMN memory_scope_id TEXT;

CREATE INDEX IF NOT EXISTS idx_connector_event_scope
  ON connector_event_index(tenant_id, project_id, memory_scope_kind, memory_scope_id);

CREATE INDEX IF NOT EXISTS idx_connector_event_source_cursor
  ON connector_event_index(source_connector, source_cursor);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (34, 'Add connector event scope columns');
