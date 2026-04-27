import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from '../../src/sqlite.js';
import { RawStore } from '../../src/connectors/framework/raw-store.js';
import { applyAgentStoreTablesMigration } from '../../src/db/migrations/agent-store-tables.js';

describe('raw-ingest-isolation (M0 contract)', () => {
  let tmpDir: string;
  let mainDb: Database;
  let rawStore: RawStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mama-m0-isolation-'));
    mainDb = new Database(join(tmpDir, 'main.db'));
    applyAgentStoreTablesMigration(mainDb);
    mainDb.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        topic TEXT,
        decision TEXT,
        reasoning TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        title TEXT,
        state TEXT,
        created_at INTEGER
      );
    `);
    rawStore = new RawStore(join(tmpDir, 'raw'));
  });

  afterEach(() => {
    rawStore?.close();
    mainDb?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserting raw items via RawStore does not create decisions', () => {
    const before = mainDb.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };

    rawStore.save('telegram', [
      {
        sourceId: 'tg:1:msg:1',
        source: 'telegram',
        channel: 'tg:1',
        author: 'user1',
        content: 'Decision: adopt X next quarter',
        timestamp: new Date('2026-04-26T00:00:00Z'),
        type: 'message',
      },
    ]);

    const after = mainDb.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('inserting raw items via RawStore does not create cases', () => {
    const before = mainDb.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };

    rawStore.save('telegram', [
      {
        sourceId: 'tg:1:msg:2',
        source: 'telegram',
        channel: 'tg:1',
        author: 'user1',
        content: 'Bug found: API returns 500',
        timestamp: new Date('2026-04-26T00:01:00Z'),
        type: 'message',
      },
    ]);

    const after = mainDb.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('audited connector extraction entrypoint does not directly save memories', () => {
    const source = readFileSync(
      new URL('../../src/cli/runtime/connector-init.ts', import.meta.url),
      'utf8'
    );

    expect(source).not.toMatch(/\bsaveMemory\s*\(/);
  });
});
