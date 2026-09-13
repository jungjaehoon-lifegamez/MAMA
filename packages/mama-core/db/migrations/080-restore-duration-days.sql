-- Restore decisions.duration_days. The column is part of the original
-- decision-graph schema (001) but the 025 kind-check rebuild omitted it while
-- outcome projections still write it. Databases that already carry the column
-- skip this through the runner's duplicate-column handling.
ALTER TABLE decisions ADD COLUMN duration_days INTEGER;
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (80, 'Restore decisions.duration_days dropped by the 025 rebuild');
