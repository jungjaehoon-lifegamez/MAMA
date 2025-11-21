-- Migration 003: Add Validation Tracking Fields
-- Story: 014.7.6 - Interactive Learning Loop
-- Task: 1.2 - Add needs_validation field to decisions table
-- AC #1, #2: Validation tracking and user feedback collection
-- Date: 2025-11-14

-- Note: This migration is idempotent - duplicate column errors are handled gracefully
-- SQLite doesn't have "IF NOT EXISTS" for ALTER TABLE
-- The migration system treats "duplicate column" errors as success (idempotent)

-- Add validation tracking fields to decisions table (idempotent via migration system)
ALTER TABLE decisions ADD COLUMN needs_validation INTEGER DEFAULT 0 CHECK (needs_validation IN (0, 1));
ALTER TABLE decisions ADD COLUMN validation_attempts INTEGER DEFAULT 0;
ALTER TABLE decisions ADD COLUMN last_validated_at INTEGER;
ALTER TABLE decisions ADD COLUMN usage_count INTEGER DEFAULT 0;

-- Indexes for efficient queries (CREATE INDEX IF NOT EXISTS is supported)
CREATE INDEX IF NOT EXISTS idx_decisions_needs_validation ON decisions(needs_validation) WHERE needs_validation = 1;
CREATE INDEX IF NOT EXISTS idx_decisions_last_validated ON decisions(last_validated_at);
CREATE INDEX IF NOT EXISTS idx_decisions_usage_count ON decisions(usage_count) WHERE usage_count >= 10;

-- Update existing decisions: user_involvement='approved' don't need validation
-- Only update rows that don't have needs_validation set
UPDATE decisions SET needs_validation = 0 WHERE user_involvement = 'approved' AND needs_validation IS NULL;
UPDATE decisions SET needs_validation = 1 WHERE user_involvement = 'system_generated' AND needs_validation IS NULL;

-- Note: SQLite doesn't support DROP COLUMN, so rollback keeps columns
-- Rollback would require recreating the table (not recommended for production)
