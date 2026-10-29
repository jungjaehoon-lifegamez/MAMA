-- Upkeep subjects the runner has settled for good: checked, or lost after its last attempt.
-- Attempts are counted from the stored order rows, and the mailbox deletes acked rows after seven
-- days, so without this record a subject whose scan has no time bound (the board reconcile's stale
-- items) would be ordered three more times every week, kept or lost. A settled subject is never
-- ordered again; new work on the same thing is a new subject with a new key.
CREATE TABLE IF NOT EXISTS upkeep_settled (
  kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('checked', 'lost')),
  settled_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_key)
);

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('standalone', 3, 'Upkeep subjects settled for good, kept past the mailbox retention');
