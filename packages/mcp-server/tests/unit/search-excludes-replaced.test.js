/**
 * W31.5: the MCP searches leave out decisions that were replaced or retired, as recall does.
 * The development memory holds hundreds of superseded rows; a search must not offer them as
 * current decisions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDB, closeDB, getAdapter } from '@jungjaehoon/mama-core/db-manager';
import path from 'path';
import fs from 'fs';
import os from 'os';

const TEST_DB_PATH = path.join(os.tmpdir(), `mama-test-search-replaced-${Date.now()}.db`);

function vec(seed) {
  const v = new Float32Array(1024);
  v[0] = 1;
  v[1] = seed * 0.001;
  return v;
}

function seed(adapter, id, status, n) {
  adapter
    .prepare(
      'INSERT INTO decisions (id, topic, decision, status, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, `topic-${id}`, `decision text ${id}`, status, Date.now());
  const { rowid } = adapter.prepare('SELECT rowid FROM decisions WHERE id = ?').get(id);
  adapter.insertEmbedding(rowid, vec(n));
}

describe('MCP search leaves out replaced decisions', () => {
  beforeAll(async () => {
    process.env.MAMA_DB_PATH = TEST_DB_PATH;
    await initDB();
    const adapter = getAdapter();
    seed(adapter, 'current', 'active', 1);
    seed(adapter, 'replaced', 'superseded', 2);
    seed(adapter, 'retired', 'stale', 3);
  });

  afterAll(async () => {
    await closeDB();
    for (const file of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
      fs.rmSync(file, { force: true });
    }
  });

  it('returns the active decision and none that were replaced or retired', async () => {
    const { searchByEmbedding } = await import('../../src/mama/search-engine.js');
    const results = await searchByEmbedding(Array.from(vec(1)), { limit: 10, threshold: 0 });
    const ids = results.map((row) => row.id);
    expect(ids).toContain('current');
    expect(ids).not.toContain('replaced');
    expect(ids).not.toContain('retired');
  });
});
