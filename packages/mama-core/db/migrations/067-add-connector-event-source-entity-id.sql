-- Migration 067: give connector_event_index a first-class source_entity_id so an agent can read an
-- entity's change history (the revisions save() preserves) through the same grant-bounded core index
-- it already searches. Previously sourceEntityId lived only inside metadata_json, with no by-entity
-- query. Additive and backward-compatible: existing rows are backfilled from metadata_json.
ALTER TABLE connector_event_index ADD COLUMN source_entity_id TEXT;

UPDATE connector_event_index
  SET source_entity_id = json_extract(metadata_json, '$.sourceEntityId')
  WHERE source_entity_id IS NULL
    AND metadata_json IS NOT NULL
    AND json_extract(metadata_json, '$.sourceEntityId') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connector_event_source_entity
  ON connector_event_index(source_connector, source_entity_id);
