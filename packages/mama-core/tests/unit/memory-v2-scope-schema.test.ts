import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { initDB, getAdapter } from '../../src/db-manager.js';

const TEST_DB = '/tmp/test-memory-v2-scope-schema.db';

describe('Memory V2 scope schema', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should create memory_scopes and memory_scope_bindings tables', async () => {
    await initDB();
    const adapter = getAdapter();

    const scopes = adapter
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scopes'`)
      .all();
    const bindings = adapter
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scope_bindings'`)
      .all();

    expect(scopes).toHaveLength(1);
    expect(bindings).toHaveLength(1);
  });
});
