ALTER TABLE decisions ADD COLUMN kind TEXT DEFAULT 'decision'
  CHECK (kind IN ('decision', 'preference', 'constraint', 'lesson', 'fact'));

ALTER TABLE decisions ADD COLUMN status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'superseded', 'contradicted', 'stale'));

ALTER TABLE decisions ADD COLUMN summary TEXT;

UPDATE decisions
SET summary = decision
WHERE summary IS NULL;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (16, 'Add memory v2 kind/status/summary columns');
