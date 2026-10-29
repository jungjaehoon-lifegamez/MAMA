-- A run's child runs are read by parent, and only the product reads them that way: the upkeep and
-- record-order runners wait for an order run's children, and the write-back scan reads and checks
-- each question turn with its children. Core never queries by parent, so the index lives with the
-- package that does. Without it every lookup scans model_runs; on a copy of a live install the
-- write-back scan took about 3 s per pass, and about 50 ms with this index.
CREATE INDEX IF NOT EXISTS idx_model_runs_parent
  ON model_runs(parent_model_run_id)
  WHERE parent_model_run_id IS NOT NULL;

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('standalone', 2, 'Index model runs by parent run, for the product runners that read children');
