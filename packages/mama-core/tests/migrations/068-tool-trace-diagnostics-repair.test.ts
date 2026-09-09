/**
 * Regression: repairSkippedFeatureMigrations must not take the migration-068
 * write path on a database that is already complete.
 *
 * Acceptance Criteria
 * AC1: A complete database (all migrations applied) does not enter
 *      recoverToolTraceDiagnosticsMigration068() on a repeat runMigrations().
 * AC2: A database missing one of the 068 indexes DOES enter it, and the index
 *      is restored (the existing repair behaviour stays intact).
 */
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const dbPaths: string[] = [];

function openAdapter(): NodeSQLiteAdapter {
  const dbPath = join(os.tmpdir(), `test-068-repair-${randomUUID()}.db`);
  dbPaths.push(dbPath);
  const adapter = new NodeSQLiteAdapter({ dbPath });
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  return adapter;
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

describe('migration 068 repair guard', () => {
  it('AC1 does not enter the 068 recovery path on a complete database', () => {
    const adapter = openAdapter();
    const recover = vi.spyOn(
      adapter as unknown as { recoverToolTraceDiagnosticsMigration068: () => void },
      'recoverToolTraceDiagnosticsMigration068'
    );
    adapter.runMigrations(MIGRATIONS_DIR);
    expect(recover).not.toHaveBeenCalled();
    adapter.disconnect();
  });

  it('AC2 still repairs a database missing an 068 index', () => {
    const adapter = openAdapter();
    adapter.exec('DROP INDEX idx_tool_traces_channel_recency');
    const recover = vi.spyOn(
      adapter as unknown as { recoverToolTraceDiagnosticsMigration068: () => void },
      'recoverToolTraceDiagnosticsMigration068'
    );
    adapter.runMigrations(MIGRATIONS_DIR);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(
      adapter
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tool_traces_channel_recency'`
        )
        .all()
    ).toHaveLength(1);
    adapter.disconnect();
  });
});
