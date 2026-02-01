-- Migration 004: Add Trust Context Support
-- Story 014.7.10: Claude-Friendly Context Formatting
-- AC #2: Trust Context Schema
-- Date: 2025-11-14

-- Add trust_context JSON field for 5 trust components
ALTER TABLE decisions ADD COLUMN trust_context TEXT;

-- Add usage tracking fields for implicit feedback
ALTER TABLE decisions ADD COLUMN usage_success INTEGER DEFAULT 0;
ALTER TABLE decisions ADD COLUMN usage_failure INTEGER DEFAULT 0;
ALTER TABLE decisions ADD COLUMN time_saved INTEGER DEFAULT 0;  -- milliseconds saved

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_decisions_usage_success ON decisions(usage_success DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_time_saved ON decisions(time_saved DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_needs_validation_usage ON decisions(needs_validation, usage_success) WHERE needs_validation = 1;
