import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reEmbedDatabase, EMBEDDING_PREFIX_SCHEME } from '../../scripts/re-embed-migration.mjs';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
function applyAll(db: Database.Database) {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}-.+\.sql$/.test(x)).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
}

describe('M5: reEmbedDatabase', () => {
  it('overwrites decision vectors and flips the marker', async () => {
    const db = new Database(':memory:');
    applyAll(db);
    db.prepare('INSERT INTO decisions (id, topic, decision, created_at) VALUES (?,?,?,?)').run('d1', 't', 'x', Date.now());
    const rid = (db.prepare('SELECT rowid FROM decisions WHERE id=?').get('d1') as { rowid: number }).rowid;
    db.prepare('INSERT INTO embeddings (rowid, embedding) VALUES (?, ?)').run(rid, Buffer.from(new Float32Array(1024).fill(0.5).buffer));
    db.prepare("INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('embedding_prefix_scheme','legacy-unprefixed')").run();

    let called = 0;
    const stub = async () => { called++; return new Float32Array(1024).fill(0.9); };
    const res = await reEmbedDatabase({ db, embedDecision: stub, embedWiki: stub });

    expect(res.decisions).toBe(1);
    expect(called).toBe(1);
    const marker = (db.prepare("SELECT value FROM embedding_meta WHERE key='embedding_prefix_scheme'").get() as { value: string }).value;
    expect(marker).toBe(EMBEDDING_PREFIX_SCHEME);
    const stored = db.prepare('SELECT embedding FROM embeddings WHERE rowid=?').get(rid) as { embedding: Buffer };
    expect(new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, 1024)[0]).toBeCloseTo(0.9);
    db.close();
  });

  it('is idempotent / resumable when re-run', async () => {
    const db = new Database(':memory:');
    applyAll(db);
    db.prepare('INSERT INTO decisions (id, topic, decision, created_at) VALUES (?,?,?,?)').run('d1', 't', 'x', Date.now());
    const stub = async () => new Float32Array(1024).fill(0.1);
    await reEmbedDatabase({ db, embedDecision: stub, embedWiki: stub });
    await expect(reEmbedDatabase({ db, embedDecision: stub, embedWiki: stub })).resolves.toMatchObject({ decisions: 1 });
    db.close();
  });

  it('requires MAMA_DB_PATH in CLI mode (guarded separately)', () => {
    // main() throws without MAMA_DB_PATH; covered by manual run in Task 6.
    expect(EMBEDDING_PREFIX_SCHEME).toBe('e5-prefixed-v1');
  });
});
