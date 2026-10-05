-- Korean writes particles onto the word and Japanese writes no spaces, so the unicode61 index of
-- decisions_fts matches a Korean or Japanese word only where it stands alone (a query word met
-- its standalone form in fewer records than its attached forms in 1,294 of the agent's real
-- query tokens of two characters). A trigram index matches any run of three characters or more
-- inside the text; a two-character word is matched through the index vocabulary, as every
-- trigram that starts or ends with it.
--
-- A migration that rebuilds decisions drops these triggers with the table, as 025 dropped 015's;
-- it must recreate them, as 092 and 098 recreate decisions_fts's.
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_trigram USING fts5(
  topic, decision, reasoning,
  content='decisions',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_trigram_vocab USING fts5vocab(decisions_trigram, 'row');

DROP TRIGGER IF EXISTS decisions_trigram_ai;
DROP TRIGGER IF EXISTS decisions_trigram_ad;
DROP TRIGGER IF EXISTS decisions_trigram_au;
DROP TRIGGER IF EXISTS decisions_trigram_au2;

CREATE TRIGGER decisions_trigram_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_trigram(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;
CREATE TRIGGER decisions_trigram_ad BEFORE DELETE ON decisions BEGIN
  INSERT INTO decisions_trigram(decisions_trigram, rowid, topic, decision, reasoning)
  VALUES ('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;
CREATE TRIGGER decisions_trigram_au BEFORE UPDATE ON decisions BEGIN
  INSERT INTO decisions_trigram(decisions_trigram, rowid, topic, decision, reasoning)
  VALUES ('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;
CREATE TRIGGER decisions_trigram_au2 AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_trigram(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;

INSERT INTO decisions_trigram(decisions_trigram) VALUES ('rebuild');
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (100, 'Trigram index of decisions for Korean and Japanese words');
