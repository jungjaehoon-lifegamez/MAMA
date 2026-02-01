-- ══════════════════════════════════════════════════════════════
-- Migration 011: Fix Timestamp Convention
-- ══════════════════════════════════════════════════════════════
--
-- Issue: Schema DEFAULT uses unixepoch() (seconds) but app inserts Date.now() (milliseconds)
-- Fix: Document convention and add validation trigger to prevent accidental second-based inserts
--
-- Note: SQLite doesn't support ALTER COLUMN to change DEFAULT values.
-- Instead, we add a trigger to validate/convert timestamps on insert.
-- ══════════════════════════════════════════════════════════════

-- Timestamp threshold: 2020-01-01 in milliseconds = 1577836800000
-- Any value below this is likely in seconds and needs conversion

-- Create trigger to validate timestamps are in milliseconds
-- If a timestamp looks like seconds (< year 2000 in ms), convert it
DROP TRIGGER IF EXISTS validate_decision_timestamp;
CREATE TRIGGER validate_decision_timestamp
AFTER INSERT ON decisions
WHEN NEW.created_at < 1577836800000  -- Before 2020 in milliseconds = probably seconds
BEGIN
  UPDATE decisions
  SET created_at = NEW.created_at * 1000,
      updated_at = CASE
        WHEN NEW.updated_at < 1577836800000 THEN NEW.updated_at * 1000
        ELSE NEW.updated_at
      END
  WHERE rowid = NEW.rowid;
END;

-- Same for decision_edges table
DROP TRIGGER IF EXISTS validate_edge_timestamp;
CREATE TRIGGER validate_edge_timestamp
AFTER INSERT ON decision_edges
WHEN NEW.created_at IS NOT NULL AND NEW.created_at < 1577836800000
BEGIN
  UPDATE decision_edges
  SET created_at = NEW.created_at * 1000
  WHERE from_id = NEW.from_id AND to_id = NEW.to_id AND relationship = NEW.relationship;
END;

-- Update schema version
INSERT OR REPLACE INTO schema_version (version, description, applied_at)
VALUES (11, 'Fix timestamp convention: auto-convert seconds to milliseconds', unixepoch() * 1000);

-- ══════════════════════════════════════════════════════════════
-- Documentation: TIMESTAMP CONVENTION
-- ══════════════════════════════════════════════════════════════
-- All timestamps in MAMA are stored in MILLISECONDS (JavaScript Date.now()).
--
-- The schema DEFAULT (unixepoch()) returns seconds, but:
-- 1. All app code explicitly provides Date.now() (milliseconds)
-- 2. This trigger auto-converts any accidental second-based inserts
--
-- This ensures timestamp comparisons always work correctly.
-- ══════════════════════════════════════════════════════════════
