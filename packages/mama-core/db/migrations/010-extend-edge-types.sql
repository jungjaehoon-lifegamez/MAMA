-- ══════════════════════════════════════════════════════════════
-- MAMA Migration 010: Extend Edge Types
-- ══════════════════════════════════════════════════════════════
-- Version: 1.3
-- Date: 2025-11-26
-- Purpose: Add builds_on, debates, synthesizes relationship types
-- Story: 2.1 - Edge Type Extension
-- ══════════════════════════════════════════════════════════════

-- SQLite doesn't support ALTER TABLE to modify CHECK constraints.
-- We need to recreate the table with expanded CHECK constraint.

-- Step 1: Create new table with extended edge types
CREATE TABLE IF NOT EXISTS decision_edges_new (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  reason TEXT,
  weight REAL DEFAULT 1.0,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  created_by TEXT DEFAULT 'user' CHECK (created_by IN ('llm', 'user')),
  approved_by_user INTEGER DEFAULT 1 CHECK (approved_by_user IN (0, 1)),
  decision_id TEXT,
  evidence TEXT,

  PRIMARY KEY (from_id, to_id, relationship),
  FOREIGN KEY (from_id) REFERENCES decisions(id),
  FOREIGN KEY (to_id) REFERENCES decisions(id),

  -- Extended CHECK constraint: original + v1.3 types
  CHECK (relationship IN ('supersedes', 'refines', 'contradicts', 'builds_on', 'debates', 'synthesizes')),
  CHECK (weight >= 0.0 AND weight <= 1.0)
);

-- Step 2: Copy existing data (explicit columns to handle schema variations)
INSERT OR IGNORE INTO decision_edges_new (from_id, to_id, relationship, reason, weight, created_at, created_by, approved_by_user, decision_id, evidence)
SELECT from_id, to_id, relationship, reason, weight, created_at, created_by, approved_by_user, decision_id, evidence FROM decision_edges;

-- Step 3: Drop old table
DROP TABLE IF EXISTS decision_edges;

-- Step 4: Rename new table
ALTER TABLE decision_edges_new RENAME TO decision_edges;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_edges_from ON decision_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON decision_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_relationship ON decision_edges(relationship);

-- Update schema version
INSERT OR REPLACE INTO schema_version (version, description, applied_at)
VALUES (10, 'Extend edge types: builds_on, debates, synthesizes', unixepoch() * 1000);

-- ══════════════════════════════════════════════════════════════
-- End of Migration 010
-- ══════════════════════════════════════════════════════════════
