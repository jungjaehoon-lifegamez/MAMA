-- TG-03/04/05: additive diagnostic evidence, scoped by host metadata.
-- The migration runner reconciles existing MetricsStore scope columns idempotently.
-- NULL scope preserves legacy records without granting discovery access.
ALTER TABLE tool_traces ADD COLUMN diagnostic_json TEXT;
ALTER TABLE tool_traces ADD COLUMN evidence_json TEXT;
ALTER TABLE tool_traces ADD COLUMN catalog_revision TEXT;
ALTER TABLE tool_traces ADD COLUMN owner_scope TEXT;
ALTER TABLE tool_traces ADD COLUMN project_id TEXT;
ALTER TABLE tool_traces ADD COLUMN channel_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tool_traces_scope_recency
  ON tool_traces(owner_scope, project_id, created_at DESC, trace_id DESC);
CREATE INDEX IF NOT EXISTS idx_tool_traces_channel_recency
  ON tool_traces(owner_scope, project_id, channel_id, created_at DESC, trace_id DESC);
