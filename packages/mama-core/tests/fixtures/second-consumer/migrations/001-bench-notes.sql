-- This consumer's own table. It holds nothing; it proves a consumer can bring schema the core
-- has never heard of, beside the core's, under its own migration name.
CREATE TABLE IF NOT EXISTS bench_notes (
  note_id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
