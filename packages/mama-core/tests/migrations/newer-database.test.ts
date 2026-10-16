/**
 * A database a newer version migrated is refused before anything writes to it: older code cannot
 * read a schema it does not know, and a repair or migration run on it would make that worse.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { highestMigrationVersion, MIGRATIONS_DIR, openDatabase } from '../../src/db-manager.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a database newer than the code', () => {
  it('names the highest migration among the files', () => {
    const highest = highestMigrationVersion(MIGRATIONS_DIR);
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => /^\d+-.*\.sql$/.test(file));
    expect(highest).toBe(Math.max(...files.map((file) => Number.parseInt(file, 10))));
  });

  it('is refused before any repair or migration writes to it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-newer-db-'));
    roots.push(root);
    const path = join(root, 'memory.db');
    const first = await openDatabase({ path });
    first.adapter.disconnect();

    const highest = highestMigrationVersion(MIGRATIONS_DIR);
    const db = new Database(path);
    const hasSource = (
      db.prepare('PRAGMA table_info(schema_version)').all() as { name: string }[]
    ).some((column) => column.name === 'source');
    if (hasSource) {
      db.prepare("INSERT INTO schema_version (source, version) VALUES ('core', ?)").run(
        highest + 1
      );
    } else {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(highest + 1);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const before = statSync(path).mtimeMs;

    await expect(openDatabase({ path })).rejects.toThrow(
      new RegExp(`core schema is at ${highest + 1}, newer than this version knows \\(${highest}\\)`)
    );
    expect(statSync(path).mtimeMs).toBe(before);
  });
});
