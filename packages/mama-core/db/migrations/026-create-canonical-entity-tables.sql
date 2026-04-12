CREATE TABLE IF NOT EXISTS entity_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'person', 'organization', 'work_item')),
  preferred_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'archived')),
  scope_kind TEXT CHECK (scope_kind IN ('project', 'channel', 'user', 'global')),
  scope_id TEXT,
  merged_into TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (merged_into) REFERENCES entity_nodes(id),
  CHECK ((scope_kind = 'global' AND scope_id IS NULL) OR (scope_kind != 'global'))
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  lang TEXT,
  script TEXT,
  label_type TEXT NOT NULL CHECK (label_type IN ('pref', 'alt', 'hidden', 'source_native')),
  source_type TEXT NOT NULL,
  source_ref TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suppressed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (entity_id) REFERENCES entity_nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_observations (
  id TEXT PRIMARY KEY,
  entity_kind_hint TEXT CHECK (entity_kind_hint IN ('project', 'person', 'organization', 'work_item')),
  surface_form TEXT NOT NULL,
  normalized_form TEXT NOT NULL,
  lang TEXT,
  script TEXT,
  context_summary TEXT,
  related_surface_forms TEXT NOT NULL DEFAULT '[]',
  timestamp_observed INTEGER,
  scope_kind TEXT CHECK (scope_kind IN ('project', 'channel', 'user', 'global')),
  scope_id TEXT,
  extractor_version TEXT NOT NULL,
  embedding_model_version TEXT,
  source_connector TEXT NOT NULL,
  source_raw_db_ref TEXT,
  source_raw_record_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  CHECK ((scope_kind = 'global' AND scope_id IS NULL) OR (scope_kind != 'global'))
);

CREATE TABLE IF NOT EXISTS entity_links (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_basis TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (from_entity_id) REFERENCES entity_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_entity_id) REFERENCES entity_nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_timeline_events (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  observed_at INTEGER,
  source_ref TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (entity_id) REFERENCES entity_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entity_nodes_kind ON entity_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_entity_nodes_preferred_label ON entity_nodes(preferred_label);
CREATE INDEX IF NOT EXISTS idx_entity_nodes_scope ON entity_nodes(scope_kind, scope_id);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity_id ON entity_aliases(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_normalized_label ON entity_aliases(normalized_label);

CREATE INDEX IF NOT EXISTS idx_entity_observations_normalized_label ON entity_observations(normalized_form);
CREATE INDEX IF NOT EXISTS idx_entity_observations_observed_at ON entity_observations(timestamp_observed);
CREATE INDEX IF NOT EXISTS idx_entity_observations_scope ON entity_observations(scope_kind, scope_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_observations_source_record
  ON entity_observations(source_connector, source_raw_record_id);

CREATE INDEX IF NOT EXISTS idx_entity_links_from ON entity_links(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_to ON entity_links(to_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_timeline_events_entity_id ON entity_timeline_events(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_timeline_events_observed_at ON entity_timeline_events(observed_at);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (26, 'Create canonical entity core tables');
