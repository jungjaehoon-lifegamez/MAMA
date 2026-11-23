-- Migration 012 creates the checkpoints table only when it is missing, so a table made before
-- recent_conversation existed kept the old shape and every checkpoint save failed on it.
-- SQLite has no ADD COLUMN IF NOT EXISTS and a fresh database already has the column, so the
-- runner adds it only where it is missing (node-sqlite-adapter, version 107); this file records
-- the version.
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (107, 'Add recent_conversation to checkpoints tables made before it existed');
