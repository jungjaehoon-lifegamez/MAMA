import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDB, getAdapter, fts5Search } from '../../src/db-manager.js';
import * as fs from 'node:fs';

const TEST_DB = '/tmp/test-fts5-search.db';

describe('FTS5 search', () => {
  beforeAll(async () => {
    // Clean up any previous test DB
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* cleanup */
    }
    try {
      fs.unlinkSync(TEST_DB + '-journal');
    } catch {
      /* cleanup */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* cleanup */
    }
    try {
      fs.unlinkSync(TEST_DB + '-shm');
    } catch {
      /* cleanup */
    }

    process.env.MAMA_DB_PATH = TEST_DB;
    await initDB();

    // Insert test decisions
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      'dec_ts_1',
      'typescript_config',
      'Use strict mode',
      'Better type safety',
      0.9,
      Date.now(),
      Date.now()
    );
    stmt.run(
      'dec_db_1',
      'database_choice',
      'Use SQLite',
      'Local-first, no server needed',
      0.85,
      Date.now(),
      Date.now()
    );
    stmt.run(
      'dec_auth_1',
      'auth_strategy',
      'Use JWT tokens',
      'Stateless authentication',
      0.8,
      Date.now(),
      Date.now()
    );
  });

  afterAll(() => {
    try {
      fs.unlinkSync(TEST_DB);
    } catch {
      /* cleanup */
    }
    try {
      fs.unlinkSync(TEST_DB + '-journal');
    } catch {
      /* cleanup */
    }
    try {
      fs.unlinkSync(TEST_DB + '-wal');
    } catch {
      /* cleanup */
    }
    try {
      fs.unlinkSync(TEST_DB + '-shm');
    } catch {
      /* cleanup */
    }
    delete process.env.MAMA_DB_PATH;
  });

  it('should find decisions matching keyword', async () => {
    const results = await fts5Search('typescript');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('dec_ts_1');
  });

  it('should find decisions matching multiple keywords', async () => {
    const results = await fts5Search('SQLite database');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('dec_db_1');
  });

  it('should return empty for no match', async () => {
    const results = await fts5Search('kubernetes');
    expect(results).toHaveLength(0);
  });

  it('should respect limit', async () => {
    const results = await fts5Search('use', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('should handle special characters gracefully', async () => {
    // FTS5 syntax errors should be caught
    const results = await fts5Search('test"invalid');
    // Should not throw, returns empty or results
    expect(Array.isArray(results)).toBe(true);
  });
});
