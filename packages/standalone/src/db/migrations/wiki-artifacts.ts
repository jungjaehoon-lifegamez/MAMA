import type { SQLiteDatabase } from '../../sqlite.js';

export function applyWikiArtifactsMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_artifacts (
      artifact_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      compiled_at TEXT NOT NULL,
      source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
      source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_artifacts_updated_at
    ON wiki_artifacts(updated_at_ms DESC);
  `);
}
