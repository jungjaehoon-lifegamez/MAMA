-- Backend-reported run usage. Historical and unreported values remain NULL.
-- Each value is as the backend reports it: a Codex run's input_tokens include its cached input,
-- a Claude run's exclude cache reads and writes (model_provider tells them apart).
ALTER TABLE model_runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE model_runs ADD COLUMN cache_read_input_tokens INTEGER;
ALTER TABLE model_runs ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE model_runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE model_runs ADD COLUMN compaction_count INTEGER;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (101, 'Per-run token usage and context compactions');
