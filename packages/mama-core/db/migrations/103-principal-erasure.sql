-- Erasure is an explicit exception to append-only personal records. The receipt
-- contains identifiers, time and counts, never a copy or hash of erased content.
ALTER TABLE decisions ADD COLUMN erased_at INTEGER CHECK (erased_at IS NULL OR erased_at >= 0);
ALTER TABLE command_bindings ADD COLUMN erased_at INTEGER CHECK (erased_at IS NULL OR erased_at >= 0);
ALTER TABLE model_runs ADD COLUMN erased_at INTEGER CHECK (erased_at IS NULL OR erased_at >= 0);
ALTER TABLE model_runs ADD COLUMN erased_principal_id TEXT;
ALTER TABLE tool_traces ADD COLUMN erased_at INTEGER CHECK (erased_at IS NULL OR erased_at >= 0);

CREATE TABLE IF NOT EXISTS principal_erasure_receipts (
  command_id TEXT PRIMARY KEY CHECK (length(trim(command_id)) > 0),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  erased_at INTEGER NOT NULL CHECK (erased_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('erased', 'nothing_to_erase')),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json) AND json_type(counts_json) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_principal_erasure_receipts_principal
  ON principal_erasure_receipts(principal_id, erased_at, command_id);

-- mailbox_seen originally had no principal. Recover only unambiguous live refs;
-- a pruned historical ref with no surviving input has no provable owner.
ALTER TABLE mailbox_seen ADD COLUMN principal_id TEXT;
UPDATE mailbox_seen SET principal_id = (
  SELECT MIN(i.principal_id) FROM mailbox_input_refs r
  JOIN mailbox_inputs i ON i.id = r.input_id WHERE r.ref_id = mailbox_seen.ref_id
  HAVING COUNT(DISTINCT i.principal_id) = 1
);
CREATE INDEX IF NOT EXISTS idx_mailbox_seen_principal ON mailbox_seen(principal_id, ref_id);

-- The production runner disables foreign keys before its transaction; direct
-- SQL migration users must do the same before executing this rebuild.
PRAGMA foreign_keys = OFF;
CREATE TABLE judgment_commands_103 (
  command_id TEXT PRIMARY KEY REFERENCES command_bindings(command_id) ON DELETE RESTRICT,
  record_id TEXT REFERENCES decisions(id) ON DELETE RESTRICT,
  committed_watermark INTEGER NOT NULL CHECK (committed_watermark >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  erased_at INTEGER CHECK (erased_at IS NULL OR erased_at >= 0),
  CHECK (record_id IS NOT NULL OR erased_at IS NOT NULL)
);
INSERT INTO judgment_commands_103
  SELECT command_id, record_id, committed_watermark, receipt_json, created_at, NULL FROM judgment_commands;
DROP TABLE judgment_commands;
ALTER TABLE judgment_commands_103 RENAME TO judgment_commands;
CREATE INDEX IF NOT EXISTS idx_judgment_commands_record ON judgment_commands(record_id, created_at DESC);

CREATE TABLE source_commands_103 (
  command_id TEXT PRIMARY KEY REFERENCES command_bindings(command_id) ON DELETE RESTRICT,
  observation_id TEXT REFERENCES observation_versions(observation_id) ON DELETE RESTRICT,
  event_id TEXT,
  committed_watermark INTEGER NOT NULL CHECK (committed_watermark >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  erased_at INTEGER CHECK (erased_at IS NULL OR erased_at >= 0),
  CHECK (observation_id IS NOT NULL OR erased_at IS NOT NULL)
);
INSERT INTO source_commands_103
  SELECT command_id, observation_id, event_id, committed_watermark, receipt_json, created_at, NULL FROM source_commands;
DROP TABLE source_commands;
ALTER TABLE source_commands_103 RENAME TO source_commands;
CREATE INDEX IF NOT EXISTS idx_source_commands_observation ON source_commands(observation_id, created_at DESC);

CREATE TABLE observation_versions_103 (
  observation_id TEXT PRIMARY KEY,
  source TEXT,
  source_id TEXT,
  producer_version_id TEXT,
  body TEXT,
  body_location_json TEXT,
  author TEXT,
  source_at INTEGER,
  observed_at INTEGER NOT NULL,
  content_hash TEXT,
  metadata_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  source_type TEXT,
  source_locator TEXT,
  title TEXT,
  artifact_locator TEXT,
  artifact_title TEXT,
  event_date TEXT,
  source_entity_id TEXT,
  channel TEXT,
  project_id TEXT,
  tenant_id TEXT,
  memory_scope_kind TEXT,
  memory_scope_id TEXT,
  erased_at INTEGER CHECK (erased_at IS NULL OR erased_at >= 0),
  CHECK (
    (erased_at IS NULL AND source IS NOT NULL AND source_id IS NOT NULL
      AND length(trim(source)) > 0 AND length(trim(source_id)) > 0
      AND content_hash IS NOT NULL AND length(trim(content_hash)) > 0
      AND ((body IS NOT NULL AND body_location_json IS NULL)
        OR (body IS NULL AND body_location_json IS NOT NULL)))
    OR (erased_at IS NOT NULL AND source IS NULL AND source_id IS NULL
      AND body IS NULL AND body_location_json IS NULL AND content_hash IS NULL)
  )
);
INSERT INTO observation_versions_103
  SELECT observation_id, source, source_id, producer_version_id, body, body_location_json,
    author, source_at, observed_at, content_hash, metadata_json, scope_json, source_type,
    source_locator, title, artifact_locator, artifact_title, event_date, source_entity_id,
    channel, project_id, tenant_id, memory_scope_kind, memory_scope_id, NULL
  FROM observation_versions;
DROP TABLE observation_versions;
ALTER TABLE observation_versions_103 RENAME TO observation_versions;
CREATE INDEX IF NOT EXISTS observation_source_versions ON observation_versions(source, source_id, observed_at, observation_id);
CREATE INDEX IF NOT EXISTS idx_observation_visibility ON observation_versions(source, channel, project_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_observation_artifact ON observation_versions(artifact_locator);
PRAGMA foreign_keys = ON;

-- A native turn can finish after its principal erases the running row. Keep its
-- terminal status, timing and usage, while preventing content from returning.
CREATE TRIGGER IF NOT EXISTS model_runs_erased_content AFTER UPDATE ON model_runs
WHEN new.erased_at IS NOT NULL AND (
  new.prompt_version IS NOT NULL OR new.tool_manifest_version IS NOT NULL OR
  new.output_schema_version IS NOT NULL OR new.agent_id IS NOT NULL OR new.instance_id IS NOT NULL OR
  new.envelope_hash IS NOT NULL OR new.input_snapshot_ref IS NOT NULL OR new.input_refs_json IS NOT NULL OR
  new.completion_summary IS NOT NULL OR new.error_summary IS NOT NULL
) BEGIN
  UPDATE model_runs SET prompt_version=NULL, tool_manifest_version=NULL, output_schema_version=NULL,
    agent_id=NULL, instance_id=NULL, envelope_hash=NULL, input_snapshot_ref=NULL, input_refs_json=NULL,
    completion_summary=NULL, error_summary=NULL WHERE model_run_id=new.model_run_id;
END;
CREATE TRIGGER IF NOT EXISTS tool_traces_erased_content AFTER UPDATE ON tool_traces
WHEN new.erased_at IS NOT NULL AND (
  new.tool_name<>'erased' OR new.gateway_call_id IS NOT NULL OR new.input_summary IS NOT NULL OR
  new.output_summary IS NOT NULL OR new.envelope_hash IS NOT NULL OR new.failure_code IS NOT NULL OR
  new.diagnostic_json IS NOT NULL OR new.evidence_json IS NOT NULL OR new.catalog_revision IS NOT NULL OR
  new.owner_scope IS NOT NULL OR new.project_id IS NOT NULL OR new.channel_id IS NOT NULL
) BEGIN
  UPDATE tool_traces SET tool_name='erased', gateway_call_id=NULL, input_summary=NULL, output_summary=NULL,
    envelope_hash=NULL, failure_code=NULL, diagnostic_json=NULL, evidence_json=NULL, catalog_revision=NULL,
    owner_scope=NULL, project_id=NULL, channel_id=NULL WHERE trace_id=new.trace_id;
END;
CREATE TRIGGER IF NOT EXISTS tool_traces_erased_run AFTER INSERT ON tool_traces
WHEN EXISTS (SELECT 1 FROM model_runs WHERE model_run_id=new.model_run_id AND erased_at IS NOT NULL) BEGIN
  UPDATE tool_traces SET erased_at=(SELECT erased_at FROM model_runs WHERE model_run_id=new.model_run_id),
    tool_name='erased', gateway_call_id=NULL, input_summary=NULL, output_summary=NULL,
    envelope_hash=NULL, failure_code=NULL, diagnostic_json=NULL, evidence_json=NULL, catalog_revision=NULL,
    owner_scope=NULL, project_id=NULL, channel_id=NULL WHERE trace_id=new.trace_id;
END;

INSERT OR IGNORE INTO schema_version (version, description) VALUES (103, 'Personal record export and erasure receipts');
