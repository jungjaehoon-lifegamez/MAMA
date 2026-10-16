/**
 * A database a newer version migrated is refused, when the consumer asks, before anything touches
 * it: older code cannot read a schema it does not know, and a repair or migration run on it would
 * make that worse. The check reads the file read-only before the connection opens.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

function journalMode(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return db.pragma('journal_mode', { simple: true }) as string;
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
    // Connecting switches a database to WAL; a rollback journal shows nothing connected first.
    db.pragma('journal_mode = DELETE');
    db.close();

    const refused = openDatabase({ path, migrations: sources, refuseNewerSchema: true });
    await expect(refused).rejects.toBeInstanceOf(NewerSchemaError);
    await expect(
      openDatabase({ path, migrations: sources, refuseNewerSchema: true })
    ).rejects.toThrow(/fixture schema is at 2, newer than this version knows \(1\)/);
    // Core's pending migration did not run, and nothing connected, before the refusal.
    expect(hasTable(path, 'mailbox_host_checkpoints')).toBe(false);
    expect(journalMode(path)).toBe('delete');

    // A consumer that does not ask keeps today's behaviour.
    const opened = await openDatabase({ path, migrations: sources });
    opened.adapter.disconnect();
    expect(hasTable(path, 'mailbox_host_checkpoints')).toBe(true);
  });

  it('reads a table from before per-source versions as the core alone', async () => {
    // Installs older than migration 085 record versions without a source column. Their
    // numbers are the core's, so a product source has none yet and is not ahead.
    const root = mkdtempSync(join(tmpdir(), 'mama-newer-db-'));
    roots.push(root);
    const path = join(root, 'memory.db');
    const before085 = join(root, 'core-before-085');
    mkdirSync(before085);
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      const number = /^(\d+)-/.exec(file);
      if (number && Number(number[1]) < 85) {
        copyFileSync(join(MIGRATIONS_DIR, file), join(before085, file));
      }
    }
    const old = await openDatabase({ path, migrationsDir: before085 });
    old.adapter.disconnect();
    const check = new Database(path, { readonly: true });
    const columns = check.prepare('PRAGMA table_info(schema_version)').all() as Array<{
      name: string;
    }>;
    check.close();
    expect(columns.map((column) => column.name)).not.toContain('source');

    const fixture = join(root, 'fixture-migrations');
    mkdirSync(fixture);
    writeFileSync(join(fixture, '001-fixture.sql'), 'CREATE TABLE fixture_table (id TEXT);');
    const opened = await openDatabase({
      path,
      migrations: [{ name: 'fixture', dir: fixture }],
      refuseNewerSchema: true,
    });
    opened.adapter.disconnect();
    expect(hasTable(path, 'fixture_table')).toBe(true);
    expect(hasTable(path, 'mailbox_host_checkpoints')).toBe(true);
  });

  it('is refused when it records a source this version does not know', async () => {
    // A later version can bring a source of its own; its tables mean a schema this one cannot read.
    const root = mkdtempSync(join(tmpdir(), 'mama-newer-db-'));
    roots.push(root);
    const path = join(root, 'memory.db');
    const first = await openDatabase({ path });
    first.adapter.disconnect();
    const db = new Database(path);
    db.prepare("INSERT INTO schema_version (source, version) VALUES ('later', 3)").run();
    db.close();

    await expect(openDatabase({ path, refuseNewerSchema: true })).rejects.toThrow(
      /later schema is at 3, newer than this version knows \(0\)/
    );
    const opened = await openDatabase({ path });
    opened.adapter.disconnect();
  });
});
