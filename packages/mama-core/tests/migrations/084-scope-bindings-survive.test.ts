/**
 * Migration 084 rebuilds memory_scopes. Run inside the migration transaction with foreign keys
 * on, the drop cascaded to every memory scope binding: a development memory at schema 80 lost all
 * 414 bindings on its way to 099. The runner now turns foreign keys off outside the transaction.
 */
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const dbPaths: string[] = [];

afterEach(() => {
  for (const dbPath of dbPaths.splice(0)) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true, recursive: true });
    }
  }
});

describe('migration 084 keeps memory scope bindings', () => {
  it('rebuilds memory_scopes without cascading to its bindings', () => {
    // A database at schema 83, as an older development memory is, with one scoped decision.
    const before = fs.mkdtempSync(join(os.tmpdir(), 'migrations-083-'));
    dbPaths.push(before);
    for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
      if (/^\d{3}-/.test(file) && Number(file.slice(0, 3)) <= 83) {
        fs.copyFileSync(join(MIGRATIONS_DIR, file), join(before, file));
      }
    }
    const dbPath = join(os.tmpdir(), `test-084-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    adapter.runMigrations(before);
    adapter.exec(
      `INSERT INTO decisions (id, topic, decision, confidence, created_at, updated_at)
       VALUES ('decision-scoped', 'scoped', 'a scoped decision', 1, 1, 1)`
    );
    adapter.exec(
      `INSERT INTO memory_scopes (id, kind, external_id, created_at)
       VALUES ('scope_project_a', 'project', '/a', 1)`
    );
    adapter.exec(
      `INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary)
       VALUES ('decision-scoped', 'scope_project_a', 1)`
    );

    adapter.runMigrations(MIGRATIONS_DIR);

    expect(adapter.prepare('SELECT memory_id, scope_id FROM memory_scope_bindings').all()).toEqual([
      { memory_id: 'decision-scoped', scope_id: 'scope_project_a' },
    ]);
    expect(
      adapter.prepare(`SELECT 1 FROM schema_version WHERE source = 'core' AND version = 99`).get()
    ).toBeTruthy();
    expect(adapter.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    adapter.disconnect();
  });
});
