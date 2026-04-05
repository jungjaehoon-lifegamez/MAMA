-- Migration 024: Add event_date column to decisions table
-- event_date stores the ISO 8601 date when the event actually occurred
-- (distinct from created_at which is ingestion time)
ALTER TABLE decisions ADD COLUMN event_date TEXT;

CREATE INDEX IF NOT EXISTS idx_decisions_event_date ON decisions(event_date);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (24, 'Add event_date column for temporal tracking');
