-- FTS5 virtual table for keyword search
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

-- Backfill existing decisions into FTS index
INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  SELECT rowid, topic, decision, reasoning FROM decisions;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (15, 'Add FTS5 keyword search with sync triggers');
