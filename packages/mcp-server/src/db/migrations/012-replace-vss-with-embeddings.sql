-- Migration 012: Replace vss_memories (sqlite-vec virtual table) with plain embeddings table
-- Vector search now uses pure TypeScript brute-force cosine similarity.
-- No native extensions required.

CREATE TABLE IF NOT EXISTS embeddings (
  rowid INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL
);

-- Note: Data migration from vss_memories is handled programmatically in sqlite-adapter.ts
-- because vss_memories is a vec0 virtual table that requires sqlite-vec to read.
-- If sqlite-vec is available at migration time, the adapter will copy rows automatically.
