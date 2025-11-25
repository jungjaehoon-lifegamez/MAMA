-- Migration 007: Add restart_metrics table for tracking restart success rate and latency
-- Story 4.2: 재시작 성공률/지연 모니터링
-- Replaces in-memory restart-metrics with persistent SQLite storage

-- Create restart_metrics table
CREATE TABLE IF NOT EXISTS restart_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  failure_reason TEXT CHECK (failure_reason IN ('NO_CHECKPOINT', 'LOAD_ERROR', 'CONTEXT_INCOMPLETE', NULL)),
  latency_ms INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'summary')),
  narrative_count INTEGER DEFAULT 0,
  link_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for efficient querying
CREATE INDEX idx_restart_metrics_timestamp ON restart_metrics(timestamp);
CREATE INDEX idx_restart_metrics_status ON restart_metrics(status);
CREATE INDEX idx_restart_metrics_session ON restart_metrics(session_id);
CREATE INDEX idx_restart_metrics_mode ON restart_metrics(mode);
