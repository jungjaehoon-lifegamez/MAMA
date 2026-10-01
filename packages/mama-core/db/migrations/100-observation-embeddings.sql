-- Meaning search over observations: one passage vector per observation a consumer chose to
-- embed, so a query in another language or spelling can find it. Vectors are e5 passages,
-- written only by code that already uses the prefix scheme.
CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id TEXT PRIMARY KEY REFERENCES observation_versions(observation_id),
  embedding BLOB NOT NULL,
  embedded_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (100, 'Observation embeddings');
