import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
let tempDir: string | null = null;

function migrationFilesThrough031(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .filter((file) => Number(file.slice(0, 3)) <= 31)
    .sort((left, right) => left.localeCompare(right));
}

function applyThrough031(db: Database.Database): void {
  for (const file of migrationFilesThrough031()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(indexName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

describe('Story M2.1: Migration 032 duplicate-column recovery', () => {
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('repairs a partially applied 032 migration when agent_id already exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-032-'));
    const dbPath = join(tempDir, 'partial-032.db');
    const setupDb = new Database(dbPath);
    setupDb.pragma('foreign_keys = ON');
    applyThrough031(setupDb);
    setupDb.exec('ALTER TABLE decisions ADD COLUMN agent_id TEXT');
    setupDb.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    adapter.disconnect();

    const db = new Database(dbPath);
    for (const column of [
      'agent_id',
      'model_run_id',
      'envelope_hash',
      'gateway_call_id',
      'source_refs_json',
      'provenance_json',
    ]) {
      expect(columnExists(db, 'decisions', column)).toBe(true);
    }
    expect(indexExists(db, 'idx_decisions_envelope_hash')).toBe(true);
    expect(indexExists(db, 'idx_decisions_model_run_id')).toBe(true);
    expect(indexExists(db, 'idx_decisions_gateway_call_id')).toBe(true);
    expect(indexExists(db, 'idx_memory_events_memory_created')).toBe(true);

    const row = db.prepare('SELECT version FROM schema_version WHERE version = 32').get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(32);
    db.close();
  });
});
