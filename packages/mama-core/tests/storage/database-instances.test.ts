import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../../src/storage/database.js';

/**
 * `openDatabase` is what lets a caller name the database it reads. Until the
 * lifetime moved here, every reader went through one module-level connection
 * and two databases could not exist at once - the reason a reset between two
 * `getAdapter()` calls could fuse rows from one database with scores from
 * another.
 */

const scratch = mkdtempSync(join(tmpdir(), 'database-instances-'));

describe('Story PR4C: database lifetime is an instance, not a module global', () => {
  let first: DatabaseHandle;
  let second: DatabaseHandle;

  beforeAll(async () => {
    first = await openDatabase({ path: join(scratch, 'first.db') });
    second = await openDatabase({ path: join(scratch, 'second.db') });
  }, 60000);

  afterAll(async () => {
    await first?.close();
    await second?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe('AC #1: two handles are two databases', () => {
    it('opens them at the paths the caller named', () => {
      expect(first.dbPath).toContain('first.db');
      expect(second.dbPath).toContain('second.db');
      expect(first.adapter).not.toBe(second.adapter);
    });

    it('keeps a row written through one out of the other', () => {
      const now = Date.now();
      first.adapter
        .prepare(
          `INSERT INTO decisions (id, topic, decision, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('only-in-first', 'isolation/topic', 'Written through the first handle', 0.9, now, now);

      const inFirst = first.adapter
        .prepare('SELECT id FROM decisions WHERE id = ?')
        .get('only-in-first');
      const inSecond = second.adapter
        .prepare('SELECT id FROM decisions WHERE id = ?')
        .get('only-in-first');

      expect(inFirst).toBeDefined();
      expect(inSecond).toBeUndefined();
    });
  });

  describe('AC #2: a handle is migrated before the caller receives it', () => {
    it('has the tables a migrated database has', () => {
      const tables = second.adapter
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((row) => row.name));

      for (const table of ['decisions', 'memory_scopes', 'schema_version']) {
        expect(names.has(table)).toBe(true);
      }
    });
  });

  describe('AC #3: closing one leaves the other usable', () => {
    it('still reads through the handle that was not closed', async () => {
      const third = await openDatabase({ path: join(scratch, 'third.db') });
      await third.close();

      expect(() =>
        first.adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get()
      ).not.toThrow();
    }, 60000);
  });
});
