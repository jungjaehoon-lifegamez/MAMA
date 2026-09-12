-- Immutable source observations. The current event index points at the exact captured version;
-- retention of the mutable index never deletes the historical observation.
CREATE TABLE IF NOT EXISTS observation_versions (
  observation_id TEXT PRIMARY KEY,
  source_connector TEXT NOT NULL CHECK (length(trim(source_connector)) > 0),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  producer_version_id TEXT,
  body TEXT,
  body_location_json TEXT,
  author TEXT,
  source_at INTEGER,
  observed_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  metadata_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  CHECK ((body IS NOT NULL AND body_location_json IS NULL)
      OR (body IS NULL AND body_location_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS observation_source_versions
  ON observation_versions(source_connector, source_id, observed_at, observation_id);

ALTER TABLE connector_event_index ADD COLUMN current_observation_id TEXT
  REFERENCES observation_versions(observation_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (72, 'Immutable connector and owner observation versions');
