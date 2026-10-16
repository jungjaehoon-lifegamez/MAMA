/**
 * A database a newer version migrated is refused, when the consumer asks, before anything writes
 * to it: older code cannot read a schema it does not know, and a repair or migration run on it
 * would make that worse. Every source is checked before any runs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  highestMigrationVersion,
  MIGRATIONS_DIR,
  NewerSchemaError,
  openDatabase,
} from '../../src/db-manager.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hasTable(path: string, name: string): boolean {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    );
  } finally {
    db.close();
  }
}

describe('a database newer than the code', () => {
  it('is refused before any source runs, and only when the consumer asks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-newer-db-'));
    roots.push(root);
    const path = join(root, 'memory.db');
    // A second source with one migration, the way a product brings its own schema.
    const fixture = join(root, 'fixture-migrations');
    mkdirSync(fixture);
    writeFileSync(join(fixture, '001-fixture.sql'), 'CREATE TABLE fixture_table (id TEXT);');
    const sources = [{ name: 'fixture', dir: fixture }];
    const first = await openDatabase({ path, migrations: sources });
    first.adapter.disconnect();

    // Core is one migration behind (106 undone), and the fixture source is ahead.
    const highest = highestMigrationVersion(MIGRATIONS_DIR);
    const db = new Database(path);
    db.prepare("DELETE FROM schema_version WHERE source = 'core' AND version = ?").run(highest);
    db.exec('DROP TABLE mailbox_host_checkpoints');
    db.prepare("INSERT INTO schema_version (source, version) VALUES ('fixture', 2)").run();
    db.close();

    const refused = openDatabase({ path, migrations: sources, refuseNewerSchema: true });
    await expect(refused).rejects.toBeInstanceOf(NewerSchemaError);
    await expect(
      openDatabase({ path, migrations: sources, refuseNewerSchema: true })
    ).rejects.toThrow(/fixture schema is at 2, newer than this version knows \(1\)/);
    // Core's pending migration did not run before the refusal.
    expect(hasTable(path, 'mailbox_host_checkpoints')).toBe(false);

    // A consumer that does not ask keeps today's behaviour.
    const opened = await openDatabase({ path, migrations: sources });
    opened.adapter.disconnect();
    expect(hasTable(path, 'mailbox_host_checkpoints')).toBe(true);
  });
});
