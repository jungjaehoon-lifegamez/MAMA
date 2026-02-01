-- ══════════════════════════════════════════════════════════════
-- MAMA (Memory-Augmented MCP Architecture) - Initial Schema
-- ══════════════════════════════════════════════════════════════
-- Version: 1.0
-- Date: 2025-11-14
-- Purpose: Decision Graph schema for Evolutionary Decision Memory
-- ══════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════
-- 1. Decision Nodes (Core)
-- ══════════════════════════════════════════════════════════════
-- Task 1.1: Create decisions table with all fields

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,              -- "decision_mesh_structure_001"
  topic TEXT NOT NULL,              -- "mesh_structure", "auth_strategy"
  decision TEXT NOT NULL,           -- "COMPLEX", "JWT", "< 20 lines"
  reasoning TEXT,                   -- "Flexibility is important initially"

  -- Outcome Tracking (Learn-Unlearn-Relearn)
  outcome TEXT,                     -- "SUCCESS", "FAILED", "PARTIAL", NULL
  failure_reason TEXT,              -- "Performance bottleneck at 10K+ meshes"
  limitation TEXT,                  -- "Missing layer information"
  duration_days INTEGER,            -- Days until outcome determined

  -- User Involvement
  user_involvement TEXT,            -- "requested", "approved", "rejected"
  session_id TEXT,                  -- Foreign key to sessions

  -- Relationships (Explicit)
  supersedes TEXT,                  -- Previous decision ID
  superseded_by TEXT,               -- Next decision ID (NULL if current)
  refined_from TEXT,                -- JSON array: ["id1", "id2"]

  -- Confidence Evolution
  confidence REAL DEFAULT 0.5,      -- Bayesian updated (0.0-1.0)

  -- Timestamps (stored in MILLISECONDS - JavaScript Date.now() convention)
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000),

  FOREIGN KEY (supersedes) REFERENCES decisions(id),
  FOREIGN KEY (superseded_by) REFERENCES decisions(id),

  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CHECK (outcome IN ('SUCCESS', 'FAILED', 'PARTIAL') OR outcome IS NULL),
  CHECK (user_involvement IN ('requested', 'approved', 'rejected') OR user_involvement IS NULL)
);

-- Task 1.5: Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_decisions_topic ON decisions(topic);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON decisions(outcome);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_supersedes ON decisions(supersedes);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);

-- ══════════════════════════════════════════════════════════════
-- 2. Decision Edges (Explicit Relationships)
-- ══════════════════════════════════════════════════════════════
-- Task 1.2: Create decision_edges table

CREATE TABLE IF NOT EXISTS decision_edges (
  from_id TEXT NOT NULL,            -- Source decision
  to_id TEXT NOT NULL,              -- Target decision
  relationship TEXT NOT NULL,       -- "supersedes", "refines", "contradicts"
  reason TEXT,                      -- "Learned from performance failure"
  weight REAL DEFAULT 1.0,          -- Strength of relationship
  created_at INTEGER DEFAULT (unixepoch() * 1000),

  PRIMARY KEY (from_id, to_id, relationship),
  FOREIGN KEY (from_id) REFERENCES decisions(id),
  FOREIGN KEY (to_id) REFERENCES decisions(id),

  CHECK (relationship IN ('supersedes', 'refines', 'contradicts')),
  CHECK (weight >= 0.0 AND weight <= 1.0)
);

-- Task 1.5: Add indexes for graph traversal
CREATE INDEX IF NOT EXISTS idx_edges_from ON decision_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON decision_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_relationship ON decision_edges(relationship);

-- ══════════════════════════════════════════════════════════════
-- 3. Sessions (Context Preservation)
-- ══════════════════════════════════════════════════════════════
-- Task 1.3: Create sessions table

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- "session_2025-11-14-1000"
  project_path TEXT,                -- "/path/to/project"

  -- Rolling Summary (for next session)
  rolling_summary TEXT,             -- Condensed session summary
  latest_exchange TEXT,             -- Last 5 messages (JSON)

  -- Metrics
  action_count INTEGER DEFAULT 0,
  decision_count INTEGER DEFAULT 0,

  -- Timestamps
  started_at INTEGER DEFAULT (unixepoch() * 1000),
  last_active_at INTEGER DEFAULT (unixepoch() * 1000),
  ended_at INTEGER,

  CHECK (action_count >= 0),
  CHECK (decision_count >= 0)
);

-- Task 1.5: Add indexes for session queries
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at);

-- ══════════════════════════════════════════════════════════════
-- 4. Vector Search (sqlite-vss)
-- ══════════════════════════════════════════════════════════════
-- Task 1.4: Create vss_memories virtual table
-- Note: This will be initialized programmatically in memory-store.js
-- because sqlite-vss requires extension loading first
--
-- CREATE VIRTUAL TABLE vss_memories USING vss0(
--   embedding(384)                    -- multilingual-e5-small embeddings
-- );

-- ══════════════════════════════════════════════════════════════
-- Migration Metadata
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER DEFAULT (unixepoch() * 1000),
  description TEXT
);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (1, 'Initial Decision Graph schema');

-- ══════════════════════════════════════════════════════════════
-- End of Migration 001
-- ══════════════════════════════════════════════════════════════
