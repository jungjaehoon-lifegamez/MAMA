import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((x) => /^\d{3}-.+\.sql$/.test(x))
    .sort();
}
function applyAll(db: Database.Database): void {
  for (const f of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
}
// Apply every migration with a version strictly below the given number.
function applyBelow(db: Database.Database, version: number): void {
  for (const f of migrationFiles()) {
    if (parseInt(f.slice(0, 3), 10) >= version) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
}
function applyOne(db: Database.Database, version: number): void {
  const f = migrationFiles().find((x) => parseInt(x.slice(0, 3), 10) === version);
  if (!f) throw new Error(`migration ${version} not found`);
  db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mama-guard-'));
  dbPath = join(dir, 'mama.db');
  process.env.MAMA_DB_PATH = dbPath;
  process.env.MAMA_TEST_MODE = 'true';
});
afterEach(async () => {
  const { resetDBState } = await import('../../src/db-manager.js');
  resetDBState();
  delete process.env.MAMA_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('M5: embedding scheme guard', () => {
  it('fresh DB is marked e5-prefixed-v1 and initDB succeeds', async () => {
    const { initDB, getAdapter, closeDB } = await import('../../src/db-manager.js');
    await initDB();
    const row = getAdapter()
      .prepare("SELECT value FROM embedding_meta WHERE key='embedding_prefix_scheme'")
      .get() as { value: string };
    expect(row.value).toBe('e5-prefixed-v1');
    await closeDB();
  });

  it('legacy vectors + legacy marker -> initDB throws with the re-embed command', async () => {
    // Seed a pre-042 style DB: apply migrations, insert a vector, force legacy marker.
    const seed = new Database(dbPath);
    applyAll(seed);
    const buf = Buffer.from(new Float32Array(1024).fill(0.02).buffer);
    seed
      .prepare('INSERT INTO decisions (id, topic, decision, created_at) VALUES (?, ?, ?, ?)')
      .run('d1', 't', 'x', Date.now());
    const rowid = (seed.prepare('SELECT rowid FROM decisions WHERE id=?').get('d1') as {
      rowid: number;
    }).rowid;
    seed
      .prepare('INSERT OR REPLACE INTO embeddings (rowid, embedding) VALUES (?, ?)')
      .run(rowid, buf);
    seed
      .prepare(
        "INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('embedding_prefix_scheme','legacy-unprefixed')"
      )
      .run();
    seed.close();

    const { initDB } = await import('../../src/db-manager.js');
    await expect(initDB()).rejects.toThrow(/embedding-guard.*re-embed-migration\.mjs/s);
  });

  it('wiki-only legacy vectors -> migration 042 marks legacy and initDB throws', async () => {
    // Seed a DB where the ONLY stored vector lives in wiki_page_embeddings
    // (decisions/embeddings empty). Migration 042 must still mark it legacy,
    // otherwise the guard early-returns on a current marker and the legacy wiki
    // vector would be cosine-compared silently.
    const seed = new Database(dbPath);
    applyBelow(seed, 42); // everything up to and including 041
    const buf = Buffer.from(new Float32Array(1024).fill(0.03).buffer);
    seed
      .prepare(
        `INSERT INTO wiki_page_index
           (page_id, source_locator, title, page_type, content, compiled_at, updated_at)
         VALUES ('wp1', 'loc1', 't', 'entity', 'c', '2026-01-01', '2026-01-01')`
      )
      .run();
    seed
      .prepare('INSERT INTO wiki_page_embeddings (page_id, embedding) VALUES (?, ?)')
      .run('wp1', buf);
    applyOne(seed, 42);
    const marker = (
      seed
        .prepare("SELECT value FROM embedding_meta WHERE key='embedding_prefix_scheme'")
        .get() as { value: string }
    ).value;
    seed.close();
    expect(marker).toBe('legacy-unprefixed');

    const { initDB } = await import('../../src/db-manager.js');
    await expect(initDB()).rejects.toThrow(/embedding-guard.*re-embed-migration\.mjs/s);
  });

  it('migration 042 tolerates a partial legacy schema without wiki_page_embeddings', () => {
    // Mirror of the schema-40 legacy-recovery scenario: embeddings exists,
    // wiki_page_embeddings does not. 042 must not crash and must mark by the
    // stored-vector state (none here -> current).
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT);
      CREATE TABLE embeddings (rowid INTEGER PRIMARY KEY, embedding BLOB NOT NULL);
    `);
    applyOne(seed, 42); // must not throw despite the missing wiki table
    const marker = (
      seed
        .prepare("SELECT value FROM embedding_meta WHERE key='embedding_prefix_scheme'")
        .get() as { value: string }
    ).value;
    seed.close();
    expect(marker).toBe('e5-prefixed-v1'); // no vectors anywhere -> current
  });
});
