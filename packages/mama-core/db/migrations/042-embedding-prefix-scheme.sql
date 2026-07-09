-- Migration 042: track the embedding instruction-prefix scheme (e5 query/passage).
-- Fresh DB (no stored vectors) starts current; an upgraded DB with pre-existing
-- unprefixed vectors is marked legacy so the runtime guard forces a re-embed.
--
-- Robustness: a SQLite statement that references a missing table fails at prepare
-- time. Some legacy-recovery paths reach 042 with a partial schema (e.g. a DB whose
-- schema_version was fast-forwarded past migration 030, so wiki_page_embeddings does
-- not exist yet). We therefore key the marker off the decisions vector store
-- (embeddings, created in migration 013) only, and gate the whole INSERT behind a
-- sqlite_master existence check so it never references a table that is absent. The
-- runtime guard in db-manager (assertEmbeddingSchemeCurrent) still counts BOTH
-- embeddings and wiki_page_embeddings (each wrapped in try/catch), so any legacy wiki
-- vector under a legacy marker still fails loud at initDB.

CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT OR IGNORE INTO embedding_meta (key, value)
SELECT 'embedding_prefix_scheme',
  CASE
    WHEN EXISTS (SELECT 1 FROM embeddings)
    THEN 'legacy-unprefixed'
    ELSE 'e5-prefixed-v1'
  END
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (42, 'Track embedding prefix scheme (e5 query/passage)');
