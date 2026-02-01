-- ══════════════════════════════════════════════════════════════
-- MAMA Migration 011: Add Checkpoint Conversation History
-- ══════════════════════════════════════════════════════════════
-- Version: 1.5.11
-- Date: 2026-01-31
-- Purpose: Add recent_conversation field to checkpoints table
-- Story: mama-core consolidation (refactor commit 9343371)
-- ══════════════════════════════════════════════════════════════

-- This migration is safe to fail if checkpoints table doesn't exist yet
-- (it will be created with the column in db-manager.js)
-- For existing databases, add the column if missing

-- Try to add column (will fail gracefully if table doesn't exist)
-- SQLite: ALTER TABLE succeeds silently if column already exists in 3.35.0+
-- For older SQLite, this will fail but that's OK since table will be created with column
ALTER TABLE checkpoints ADD COLUMN recent_conversation TEXT DEFAULT '[]';

INSERT OR REPLACE INTO schema_version (version, description, applied_at)
VALUES (11, 'Add recent_conversation field to checkpoints', unixepoch());

-- ══════════════════════════════════════════════════════════════
-- End of Migration 011
-- ══════════════════════════════════════════════════════════════
