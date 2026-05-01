import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
let tempDir: string | null = null;

function cleanupTempDir(): void {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}

function migrationFilesThrough(version: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .filter((file) => Number(file.slice(0, 3)) <= version)
    .sort((left, right) => left.localeCompare(right));
}

function applyThrough(db: Database.Database, version: number): void {
  for (const file of migrationFilesThrough(version)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(indexName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

describe('Story M2.1: Migration 032 duplicate-column recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: partial migration recovery', () => {
      it('repairs a partially applied 032 migration when agent_id already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-032-'));
        const dbPath = join(tempDir, 'partial-032.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 31);
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
  });
});

describe('Story M2.3: Migration 034 duplicate-column recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: partial connector event scope migration recovery', () => {
      it('repairs a partially applied 034 migration when source_cursor already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-034-'));
        const dbPath = join(tempDir, 'partial-034.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 33);
        setupDb.exec('ALTER TABLE connector_event_index ADD COLUMN source_cursor TEXT');
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        for (const column of [
          'source_cursor',
          'tenant_id',
          'project_id',
          'memory_scope_kind',
          'memory_scope_id',
        ]) {
          expect(columnExists(db, 'connector_event_index', column)).toBe(true);
        }
        expect(indexExists(db, 'idx_connector_event_scope')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_source_cursor')).toBe(true);

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 34').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(34);
        db.close();
      });
    });
  });
});

describe('Story M2.4: Legacy high schema-version structural recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: skipped feature migrations', () => {
      it('repairs provenance and connector structures when legacy schema_version is already newer', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-high-version-'));
        const dbPath = join(tempDir, 'legacy-high-version.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        setupDb.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            description TEXT
          );
          INSERT INTO schema_version (version, description)
          VALUES (58, 'Legacy branch migration ahead of provenance migrations');

          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL
          );
          CREATE TABLE embeddings (
            rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
          );
          CREATE TABLE connector_event_index (
            event_index_id TEXT PRIMARY KEY,
            source_connector TEXT NOT NULL
          );
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        for (const table of [
          'model_runs',
          'tool_traces',
          'twin_edges',
          'agent_situation_packets',
          'agent_situation_refresh_leases',
          'context_packets',
        ]) {
          expect(tableExists(db, table)).toBe(true);
        }
        for (const column of [
          'source_cursor',
          'tenant_id',
          'project_id',
          'memory_scope_kind',
          'memory_scope_id',
        ]) {
          expect(columnExists(db, 'connector_event_index', column)).toBe(true);
        }
        expect(indexExists(db, 'idx_model_runs_envelope_hash')).toBe(true);
        expect(indexExists(db, 'idx_tool_traces_model_run_id')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_source_cursor')).toBe(true);
        expect(indexExists(db, 'idx_context_packets_scope_hash')).toBe(true);
        db.close();
      });
    });
  });
});
