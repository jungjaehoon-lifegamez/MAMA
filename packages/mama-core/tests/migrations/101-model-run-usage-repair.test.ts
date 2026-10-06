/**
 * Regression: migration 101 only alters model_runs. On a database whose model_runs is rebuilt by
 * the 033 repair, the 101 statements were skipped as "no such table", so the repair must add the
 * usage columns; a complete database must not take that write path.
 */
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const USAGE = [
  'input_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'output_tokens',
  'compaction_count',
];
const dbPaths: string[] = [];

function openAdapter(): NodeSQLiteAdapter {
  const dbPath = join(os.tmpdir(), `test-101-repair-${randomUUID()}.db`);
  dbPaths.push(dbPath);
  const adapter = new NodeSQLiteAdapter({ dbPath });
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  return adapter;
}

function usageColumns(adapter: NodeSQLiteAdapter): string[] {
  return (adapter.prepare('PRAGMA table_info(model_runs)').all() as Array<{ name: string }>)
    .map((column) => column.name)
    .filter((name) => USAGE.includes(name));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dbPath of dbPaths.splice(0)) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // best effort
      }
    }
  }
});

describe('migration 101 repair', () => {
  it('adds the usage columns to a model_runs table the 033 repair rebuilt', () => {
    const adapter = openAdapter();
    adapter.exec('DROP TABLE model_runs');
    adapter.runMigrations(MIGRATIONS_DIR);
    expect(usageColumns(adapter)).toEqual(USAGE);
    adapter.disconnect();
  });

  it('does not alter model_runs on a complete database', () => {
    const adapter = openAdapter();
    const exec = vi.spyOn(adapter, 'exec');
    adapter.runMigrations(MIGRATIONS_DIR);
    expect(exec.mock.calls.some(([sql]) => String(sql).includes('ALTER TABLE model_runs'))).toBe(
      false
    );
    expect(usageColumns(adapter)).toEqual(USAGE);
    adapter.disconnect();
  });
});
