ALTER TABLE entity_observations
  ADD COLUMN observation_type TEXT NOT NULL DEFAULT 'generic'
  CHECK (observation_type IN ('generic', 'author', 'channel'));

UPDATE entity_observations
SET source_raw_db_ref = ''
WHERE source_raw_db_ref IS NULL;

DROP INDEX IF EXISTS idx_entity_observations_source_record;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_observations_source_record
  ON entity_observations(
    source_connector,
    source_raw_db_ref,
    source_raw_record_id,
    observation_type
  );

CREATE TRIGGER IF NOT EXISTS trg_entity_nodes_scope_guard_insert
BEFORE INSERT ON entity_nodes
WHEN (
  (NEW.scope_kind = 'global' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_kind IS NOT NULL AND NEW.scope_kind != 'global' AND NEW.scope_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'entity_nodes scope_id invalid for scope_kind');
END;

CREATE TRIGGER IF NOT EXISTS trg_entity_nodes_scope_guard_update
BEFORE UPDATE ON entity_nodes
WHEN (
  (NEW.scope_kind = 'global' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_kind IS NOT NULL AND NEW.scope_kind != 'global' AND NEW.scope_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'entity_nodes scope_id invalid for scope_kind');
END;

CREATE TRIGGER IF NOT EXISTS trg_entity_observations_scope_guard_insert
BEFORE INSERT ON entity_observations
WHEN (
  (NEW.scope_kind = 'global' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_kind IS NOT NULL AND NEW.scope_kind != 'global' AND NEW.scope_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'entity_observations scope_id invalid for scope_kind');
END;

CREATE TRIGGER IF NOT EXISTS trg_entity_observations_scope_guard_update
BEFORE UPDATE ON entity_observations
WHEN (
  (NEW.scope_kind = 'global' AND NEW.scope_id IS NOT NULL)
  OR (NEW.scope_kind IS NOT NULL AND NEW.scope_kind != 'global' AND NEW.scope_id IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'entity_observations scope_id invalid for scope_kind');
END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (29, 'Extend entity observations with observation type and scope guards');
