import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
function applyAll(db: Database.Database): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}-.+\.sql$/.test(x)).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
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
});
