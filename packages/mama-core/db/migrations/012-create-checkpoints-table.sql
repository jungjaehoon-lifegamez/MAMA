-- Migration: 012-create-checkpoints-table.sql
-- Description: Create checkpoints table for session continuity
-- Date: 2026-02-01
--
-- Context: Move DDL from db-manager.js runtime to proper migration
-- This table stores session checkpoints for resuming conversations
--
-- Note: Timestamps use milliseconds (Date.now()) convention per migration 011

-- Create checkpoints table if not exists
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  summary TEXT NOT NULL,
  open_files TEXT, -- JSON array
  next_steps TEXT,
  recent_conversation TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active' -- 'active', 'archived'
);

-- Add recent_conversation column if not exists (backward compatibility)
-- SQLite doesn't have IF NOT EXISTS for ALTER TABLE, so we use a workaround
-- This is safe because SQLite will error on duplicate column, caught by migration runner
