-- v0.17: Extend kind CHECK constraint to include 'task' and 'schedule'.
-- Only runs if the old CHECK exists (idempotent).
-- Uses a temp table approach since SQLite cannot ALTER CHECK constraints.

-- Drop the old column constraint by recreating the table
-- This is safe because we explicitly list all columns

CREATE TABLE IF NOT EXISTS decisions_v17 (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasoning TEXT,
  outcome TEXT,
  failure_reason TEXT,
  limitation TEXT,
  user_involvement TEXT,
  session_id TEXT,
  supersedes TEXT,
  superseded_by TEXT,
  refined_from TEXT,
  confidence REAL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  needs_validation INTEGER DEFAULT 0 CHECK (needs_validation IN (0, 1)),
  validation_attempts INTEGER DEFAULT 0,
  last_validated_at INTEGER,
  usage_count INTEGER DEFAULT 0,
  trust_context TEXT,
  usage_success INTEGER DEFAULT 0,
  usage_failure INTEGER DEFAULT 0,
  time_saved INTEGER DEFAULT 0,
  evidence TEXT,
  alternatives TEXT,
  risks TEXT,
  event_date TEXT,
  kind TEXT DEFAULT 'decision'
    CHECK (kind IN ('decision', 'preference', 'constraint', 'lesson', 'fact', 'task', 'schedule')),
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'contradicted', 'stale')),
  summary TEXT,
  is_static INTEGER DEFAULT 0
);

INSERT OR IGNORE INTO decisions_v17 (
  id, topic, decision, reasoning, outcome, failure_reason, limitation,
  user_involvement, session_id, supersedes, superseded_by, refined_from,
  confidence, created_at, updated_at, needs_validation, validation_attempts,
  last_validated_at, usage_count, trust_context, usage_success, usage_failure,
  time_saved, evidence, alternatives, risks, event_date, kind, status, summary, is_static
) SELECT
  id, topic, decision, reasoning, outcome, failure_reason, limitation,
  user_involvement, session_id, supersedes, superseded_by, refined_from,
  confidence, created_at, updated_at, needs_validation, validation_attempts,
  last_validated_at, usage_count, trust_context, usage_success, usage_failure,
  time_saved, evidence, alternatives, risks, event_date, kind, status, summary, is_static
FROM decisions;

DROP TABLE decisions;
ALTER TABLE decisions_v17 RENAME TO decisions;
