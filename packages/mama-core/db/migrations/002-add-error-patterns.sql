-- ═══════════════════════════════════════════════════════════
-- MAMA (Memory-Augmented MCP Architecture) - Error Patterns Table
-- Migration 002: Add error_patterns table
--
-- Purpose: Store error patterns and their solutions for auto-resolution
-- Tasks: 3.1-3.4 (Error pattern schema)
-- AC #2, #3: Error pattern storage and auto-resolution
--
-- Version: 1.0
-- Date: 2025-11-14
-- ═══════════════════════════════════════════════════════════

-- Error Patterns Table
-- Stores error patterns, solutions, and success metrics
CREATE TABLE IF NOT EXISTS error_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Pattern Identification
  error_pattern TEXT NOT NULL,     -- Regex pattern or error signature
  error_type TEXT,                 -- Error category (e.g., 'EADDRINUSE', 'ECONNREFUSED')

  -- Solution
  solution TEXT NOT NULL,          -- Command or action to resolve
  solution_type TEXT DEFAULT 'bash',  -- 'bash', 'manual', 'code_fix'

  -- Success Metrics
  success_rate REAL DEFAULT 1.0,   -- Success rate (0.0-1.0)
  occurrences INTEGER DEFAULT 1,   -- Total number of times encountered
  successes INTEGER DEFAULT 1,     -- Number of successful resolutions

  -- Temporal Data
  last_seen INTEGER NOT NULL,      -- Last occurrence timestamp
  first_seen INTEGER NOT NULL,     -- First occurrence timestamp

  -- Vector Embedding (for semantic matching)
  embedding BLOB,                  -- 384-dim embedding (multilingual-e5-small)

  -- Metadata
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000),

  -- Constraints
  UNIQUE(error_pattern)            -- One pattern per entry
);

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_error_patterns_last_seen
  ON error_patterns(last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_error_patterns_success_rate
  ON error_patterns(success_rate DESC);

CREATE INDEX IF NOT EXISTS idx_error_patterns_error_type
  ON error_patterns(error_type);

-- ═══════════════════════════════════════════════════════════
-- VSS Table Extension for Error Patterns
-- ═══════════════════════════════════════════════════════════

-- Note: Error pattern embeddings will be stored in the same vss_memories table
-- We'll use rowid mapping: error_patterns.id → vss_memories.rowid
-- This allows unified vector search across decisions AND error patterns

-- ═══════════════════════════════════════════════════════════
-- Sample Data (Optional - for testing)
-- ═══════════════════════════════════════════════════════════

-- Uncomment to insert sample error patterns for testing:

/*
INSERT INTO error_patterns (
  error_pattern,
  error_type,
  solution,
  solution_type,
  success_rate,
  occurrences,
  successes,
  last_seen,
  first_seen
) VALUES
(
  'EADDRINUSE.*port.*already in use',
  'EADDRINUSE',
  'lsof -ti:{{PORT}} | xargs kill',
  'bash',
  1.0,
  5,
  5,
  unixepoch(),
  unixepoch() - (30 * 24 * 60 * 60)  -- 30 days ago
),
(
  'ECONNREFUSED.*Connection refused',
  'ECONNREFUSED',
  'Check if service is running: systemctl status {{SERVICE}}',
  'manual',
  0.8,
  3,
  2,
  unixepoch(),
  unixepoch() - (7 * 24 * 60 * 60)   -- 7 days ago
);
*/

-- ═══════════════════════════════════════════════════════════
-- Migration Verification
-- ═══════════════════════════════════════════════════════════

-- Check table creation
SELECT
  'Migration 002 Complete: error_patterns table created' AS status,
  COUNT(*) AS row_count
FROM error_patterns;
