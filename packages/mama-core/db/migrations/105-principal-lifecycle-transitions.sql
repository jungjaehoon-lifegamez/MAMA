CREATE TABLE IF NOT EXISTS principal_lifecycle_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_principal_lifecycle_transitions_principal
  ON principal_lifecycle_transitions(principal_id, transition_id);

CREATE TRIGGER IF NOT EXISTS principal_lifecycle_transition
AFTER UPDATE OF status ON principals
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO principal_lifecycle_transitions (principal_id, from_status, to_status, occurred_at)
  VALUES (NEW.principal_id, OLD.status, NEW.status, NEW.updated_at);
END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (105, 'Principal lifecycle transitions independent of display-name updates');
