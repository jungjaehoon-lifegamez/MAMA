ALTER TABLE connector_event_index
  ADD COLUMN operator_observation_seq INTEGER CHECK (
    operator_observation_seq IS NULL OR operator_observation_seq >= 1
  );

CREATE TABLE connector_event_index_observation_cursors (
  source_connector TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1)
);

WITH ranked AS (
  SELECT event_index_id,
         ROW_NUMBER() OVER (
           PARTITION BY source_connector
           ORDER BY source_timestamp_ms, rowid
         ) AS seq
  FROM connector_event_index
)
UPDATE connector_event_index
SET operator_observation_seq = (
  SELECT seq FROM ranked WHERE ranked.event_index_id = connector_event_index.event_index_id
);

INSERT INTO connector_event_index_observation_cursors (source_connector, next_seq)
SELECT source_connector, MAX(operator_observation_seq) + 1
FROM connector_event_index
GROUP BY source_connector;

CREATE UNIQUE INDEX idx_connector_event_index_observation_seq
  ON connector_event_index(source_connector, operator_observation_seq)
  WHERE operator_observation_seq IS NOT NULL;

CREATE TRIGGER trg_connector_event_index_operator_ingest_seq_au
AFTER UPDATE OF operator_ingest_seq ON connector_event_index
WHEN NEW.operator_ingest_seq IS NULL AND OLD.operator_ingest_seq IS NOT NULL
BEGIN
  INSERT INTO connector_event_index_operator_seq_cursors
    (source_connector, channel, next_seq)
  VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1)
  ON CONFLICT(source_connector, channel) DO NOTHING;
  UPDATE connector_event_index
  SET operator_ingest_seq = (
    SELECT next_seq FROM connector_event_index_operator_seq_cursors
    WHERE source_connector = NEW.source_connector
      AND channel = COALESCE(NEW.channel, '')
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_operator_seq_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector
    AND channel = COALESCE(NEW.channel, '');
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_observation_seq IS NULL
BEGIN
  INSERT INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1)
  ON CONFLICT(source_connector) DO NOTHING;
  UPDATE connector_event_index
  SET operator_observation_seq = (
    SELECT next_seq FROM connector_event_index_observation_cursors
    WHERE source_connector = NEW.source_connector
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector;
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_au
AFTER UPDATE OF operator_observation_seq ON connector_event_index
WHEN NEW.operator_observation_seq IS NULL AND OLD.operator_observation_seq IS NOT NULL
BEGIN
  INSERT INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1)
  ON CONFLICT(source_connector) DO NOTHING;
  UPDATE connector_event_index
  SET operator_observation_seq = (
    SELECT next_seq FROM connector_event_index_observation_cursors
    WHERE source_connector = NEW.source_connector
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector;
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_explicit_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_observation_seq IS NOT NULL
BEGIN
  INSERT INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1)
  ON CONFLICT(source_connector) DO NOTHING;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = CASE
    WHEN next_seq <= NEW.operator_observation_seq THEN NEW.operator_observation_seq + 1
    ELSE next_seq
  END
  WHERE source_connector = NEW.source_connector;
END;

INSERT INTO schema_version (version, description)
VALUES (62, 'Refresh connector event delivery and observation sequences');
