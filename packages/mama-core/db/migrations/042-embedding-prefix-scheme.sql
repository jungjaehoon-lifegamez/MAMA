-- Migration 042: track the embedding instruction-prefix scheme (e5 query/passage).
-- Fresh DB (no stored vectors) starts current; an upgraded DB with pre-existing
-- unprefixed vectors is marked legacy so the runtime guard forces a re-embed.

CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT OR IGNORE INTO embedding_meta (key, value)
SELECT 'embedding_prefix_scheme',
  CASE
    WHEN EXISTS (SELECT 1 FROM embeddings)
      OR EXISTS (SELECT 1 FROM wiki_page_embeddings)
    THEN 'legacy-unprefixed'
    ELSE 'e5-prefixed-v1'
  END;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (42, 'Track embedding prefix scheme (e5 query/passage)');
