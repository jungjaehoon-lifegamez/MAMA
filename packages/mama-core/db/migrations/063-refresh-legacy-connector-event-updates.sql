SELECT content_hash, metadata_json, source_timestamp_ms, source_type, channel,
       operator_ingest_seq, operator_observation_seq
FROM connector_event_index
LIMIT 0;

CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_legacy_content_refresh_au
AFTER UPDATE OF content_hash, metadata_json, source_timestamp_ms, source_type, channel
ON connector_event_index
WHEN (
  OLD.content_hash IS NOT NEW.content_hash
  OR OLD.metadata_json IS NOT NEW.metadata_json
  OR OLD.source_timestamp_ms IS NOT NEW.source_timestamp_ms
  OR OLD.source_type IS NOT NEW.source_type
  OR OLD.channel IS NOT NEW.channel
) AND (
  NEW.operator_ingest_seq IS OLD.operator_ingest_seq
  OR NEW.operator_observation_seq IS OLD.operator_observation_seq
)
BEGIN
  UPDATE connector_event_index
  SET operator_ingest_seq = CASE
        WHEN NEW.operator_ingest_seq IS OLD.operator_ingest_seq THEN NULL
        ELSE NEW.operator_ingest_seq
      END,
      operator_observation_seq = CASE
        WHEN NEW.operator_observation_seq IS OLD.operator_observation_seq THEN NULL
        ELSE NEW.operator_observation_seq
      END
  WHERE event_index_id = NEW.event_index_id;
END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (63, 'Refresh sequences for legacy connector event updates');
