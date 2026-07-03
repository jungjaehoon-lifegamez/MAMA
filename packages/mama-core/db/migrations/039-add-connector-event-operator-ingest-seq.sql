ALTER TABLE connector_event_index
  ADD COLUMN operator_ingest_seq INTEGER CHECK (
    operator_ingest_seq IS NULL OR operator_ingest_seq >= 1
  );

CREATE TABLE IF NOT EXISTS connector_event_index_operator_seq_cursors (
  source_connector TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1),
  PRIMARY KEY (source_connector, channel)
);

WITH ranked_events AS (
  SELECT
    event_index_id,
    ROW_NUMBER() OVER (
      PARTITION BY source_connector, COALESCE(channel, '')
      ORDER BY rowid ASC
    ) AS operator_seq
  FROM connector_event_index
)
UPDATE connector_event_index
SET operator_ingest_seq = (
  SELECT operator_seq
  FROM ranked_events
  WHERE ranked_events.event_index_id = connector_event_index.event_index_id
)
WHERE operator_ingest_seq IS NULL;

INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
  source_connector,
  channel,
  next_seq
)
SELECT
  source_connector,
  COALESCE(channel, ''),
  COALESCE(MAX(operator_ingest_seq), 0) + 1
FROM connector_event_index
GROUP BY source_connector, COALESCE(channel, '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_event_index_operator_scope_seq
  ON connector_event_index(source_connector, COALESCE(channel, ''), operator_ingest_seq)
  WHERE operator_ingest_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connector_event_index_operator_cursor_order
  ON connector_event_index(source_connector, channel, operator_ingest_seq);

CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_operator_ingest_seq_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_ingest_seq IS NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
    source_connector,
    channel,
    next_seq
  )
  VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1);

  UPDATE connector_event_index
  SET operator_ingest_seq = (
    SELECT next_seq
    FROM connector_event_index_operator_seq_cursors
    WHERE source_connector = NEW.source_connector
      AND channel = COALESCE(NEW.channel, '')
  )
  WHERE event_index_id = NEW.event_index_id;

  UPDATE connector_event_index_operator_seq_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector
    AND channel = COALESCE(NEW.channel, '');
END;

CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_operator_ingest_seq_explicit_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_ingest_seq IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
    source_connector,
    channel,
    next_seq
  )
  VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1);

  UPDATE connector_event_index_operator_seq_cursors
  SET next_seq = CASE
    WHEN next_seq <= NEW.operator_ingest_seq THEN NEW.operator_ingest_seq + 1
    ELSE next_seq
  END
  WHERE source_connector = NEW.source_connector
    AND channel = COALESCE(NEW.channel, '');
END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (39, 'Add connector event operator ingest sequence');
