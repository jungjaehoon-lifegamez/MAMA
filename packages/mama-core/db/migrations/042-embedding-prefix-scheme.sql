-- Migration 042: track the embedding instruction-prefix scheme (e5 query/passage).
-- Fresh DB (no stored vectors) starts current; an upgraded DB with pre-existing
-- unprefixed vectors (in EITHER vector store) is marked legacy so the runtime guard
-- forces a re-embed.
--
-- Robustness: a SQLite statement that references a missing table fails at prepare
-- time, so a sqlite_master-gated WHERE clause alone cannot protect a reference to an
-- absent table. Some legacy-recovery paths reach 042 with a partial schema (e.g. a DB
-- whose schema_version was fast-forwarded past migration 030, so wiki_page_embeddings
-- does not exist yet). We therefore CREATE IF NOT EXISTS both vector-store tables with
-- the exact shapes of migrations 013/030 (no-op on any normally-migrated DB, empty
-- shells on partial ones) before the marker statement references them. The runtime
-- guard in db-manager (assertEmbeddingSchemeCurrent) independently counts both tables
-- (try/catch-wrapped), so the two layers agree.

CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Shape of migration 013 (embeddings) - no-op unless the schema is partial.
CREATE TABLE IF NOT EXISTS embeddings (
  rowid INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL
);

-- Shape of migration 030 (wiki_page_embeddings) - no-op unless the schema is partial.
-- The FK to wiki_page_index resolves lazily in SQLite, so this is safe even when
-- wiki_page_index itself is absent.
CREATE TABLE IF NOT EXISTS wiki_page_embeddings (
  page_id TEXT PRIMARY KEY REFERENCES wiki_page_index(page_id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
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
