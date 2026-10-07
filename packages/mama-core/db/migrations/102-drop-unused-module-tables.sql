-- Tables of the modules mama-core 6.0.0 removed: the learned ranker, the search feedback store,
-- the channel summary stores and the memory bootstrap's truth projection. Nothing reads or writes
-- them and no trigger or view names them.
DROP TABLE IF EXISTS ranker_model_versions;
DROP TABLE IF EXISTS search_ranker_settings;
DROP TABLE IF EXISTS search_feedback;
DROP TABLE IF EXISTS channel_summaries;
DROP TABLE IF EXISTS channel_summary_state;
DROP TABLE IF EXISTS memory_truth;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (102, 'Drop the tables of modules removed in 6.0.0');
