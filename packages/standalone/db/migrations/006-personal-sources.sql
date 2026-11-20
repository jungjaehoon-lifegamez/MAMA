-- Sources a person connected from their own DM (docs/development/work/personal-connectors.md, C1).
-- One row per person and kind, with the channels they bound. The credential stays in
-- runtime/accounts/; collected items are stored as connector personal-<kind> with the person's scope.
CREATE TABLE IF NOT EXISTS personal_sources (
  principal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channels_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (principal_id, kind)
);

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('standalone', 6, 'Personal sources a person connected from their DM');
