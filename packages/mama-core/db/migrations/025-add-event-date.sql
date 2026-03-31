-- ══════════════════════════════════════════════════════════════
-- Migration 025: Add event_date to decisions
-- ══════════════════════════════════════════════════════════════
-- Purpose: Temporal metadata — stores the real-world date a fact
--          or decision pertains to (ISO 8601 date string).
--          Distinct from created_at which is the DB insertion time.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE decisions ADD COLUMN event_date TEXT;

CREATE INDEX IF NOT EXISTS idx_decisions_event_date ON decisions(event_date);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (25, 'Add event_date column to decisions');
