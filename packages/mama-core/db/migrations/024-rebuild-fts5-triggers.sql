-- Rebuild FTS5 triggers that may have been dropped during node:sqlite migration.
-- Migration 015 created these originally, but switching to node:sqlite (which lacks
-- FTS5 support) caused them to be lost. Now that better-sqlite3 is restored, we
-- recreate the triggers and rebuild the index.

-- Drop and recreate triggers to ensure clean state
DROP TRIGGER IF EXISTS decisions_ai;
DROP TRIGGER IF EXISTS decisions_ad;
DROP TRIGGER IF EXISTS decisions_au;
DROP TRIGGER IF EXISTS decisions_au2;

-- Recreate FTS5 table if missing (idempotent)
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  topic, decision, reasoning,
  content='decisions',
  content_rowid='rowid'
);

-- Sync triggers for external content table
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad BEFORE DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision, reasoning)
  VALUES('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;

CREATE TRIGGER IF NOT EXISTS decisions_au BEFORE UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision, reasoning)
  VALUES('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;

CREATE TRIGGER IF NOT EXISTS decisions_au2 AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;

-- Rebuild the entire FTS index from current decisions data
INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (24, 'Rebuild FTS5 triggers after better-sqlite3 restoration');
