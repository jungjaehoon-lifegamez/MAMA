-- Migration: 002_add_narrative_fields.sql
-- Description: Add fields for 5-layer narrative (Evidence, Tension)
-- Date: 2025-11-24

-- Add 'evidence' column for storing file paths, logs, or metrics (JSON array or string)
ALTER TABLE decisions ADD COLUMN evidence TEXT;

-- Add 'alternatives' column for Tension layer (what else was considered?)
ALTER TABLE decisions ADD COLUMN alternatives TEXT;

-- Add 'risks' column for Tension layer (what could go wrong?)
ALTER TABLE decisions ADD COLUMN risks TEXT;
