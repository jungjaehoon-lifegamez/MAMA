-- Existing decisions are legacy memory records until an explicit judgment command
-- binds them to a judgment receipt. Migration recovery in the adapter preserves
-- the same distinction for databases that already applied migration 075.

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (77, 'Distinguish legacy memory records from agent judgments');
