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

function tableSql(db: Database.Database, tableName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

function triggerExists(db: Database.Database, triggerName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(triggerName) as { name?: string } | undefined;
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

describe('Story M2.4: Migration 039 duplicate-column recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: partial connector operator sequence migration recovery', () => {
      it('repairs a partially applied 039 migration when operator_ingest_seq already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-039-'));
        const dbPath = join(tempDir, 'partial-039.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 38);
        setupDb.exec(`
          ALTER TABLE connector_event_index
            ADD COLUMN operator_ingest_seq INTEGER CHECK (
              operator_ingest_seq IS NULL OR operator_ingest_seq >= 1
            )
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        expect(columnExists(db, 'connector_event_index', 'operator_ingest_seq')).toBe(true);
        expect(tableExists(db, 'connector_event_index_operator_seq_cursors')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_scope_seq')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_cursor_order')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_ai')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_explicit_ai')).toBe(
          true
        );

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 39').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(39);
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
          CREATE TABLE memory_events (
            id INTEGER PRIMARY KEY,
            memory_id TEXT NOT NULL,
            topic TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE embeddings (
            rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
          );
          CREATE TABLE connector_event_index (
            event_index_id TEXT PRIMARY KEY,
            source_connector TEXT NOT NULL,
            channel TEXT
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
          'vnext_operator_cursors',
          'vnext_operator_commits',
          'operator_no_updates',
          'worker_proposals',
          'operator_memory_commit_intents',
        ]) {
          expect(tableExists(db, table)).toBe(true);
        }
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
        for (const column of [
          'source_cursor',
          'tenant_id',
          'project_id',
          'memory_scope_kind',
          'memory_scope_id',
          'operator_ingest_seq',
        ]) {
          expect(columnExists(db, 'connector_event_index', column)).toBe(true);
        }
        expect(tableExists(db, 'connector_event_index_operator_seq_cursors')).toBe(true);
        expect(indexExists(db, 'idx_model_runs_envelope_hash')).toBe(true);
        expect(indexExists(db, 'idx_tool_traces_model_run_id')).toBe(true);
        expect(indexExists(db, 'idx_decisions_envelope_hash')).toBe(true);
        expect(indexExists(db, 'idx_decisions_model_run_id')).toBe(true);
        expect(indexExists(db, 'idx_decisions_gateway_call_id')).toBe(true);
        expect(indexExists(db, 'idx_memory_events_memory_created')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_source_cursor')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_scope_seq')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_cursor_order')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_ai')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_explicit_ai')).toBe(
          true
        );
        expect(indexExists(db, 'idx_context_packets_scope_hash')).toBe(true);
        expect(indexExists(db, 'idx_vnext_operator_commits_cursor_seq')).toBe(true);
        expect(indexExists(db, 'idx_operator_no_updates_scope_created')).toBe(true);
        expect(indexExists(db, 'idx_worker_proposals_status_kind')).toBe(true);
        expect(indexExists(db, 'idx_operator_memory_commit_intents_cursor_created')).toBe(true);

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 38').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(38);
        const operatorSeqRow = db
          .prepare('SELECT version FROM schema_version WHERE version = 39')
          .get() as { version: number } | undefined;
        expect(operatorSeqRow?.version).toBe(39);
        const memoryIntentRow = db
          .prepare('SELECT version FROM schema_version WHERE version = 40')
          .get() as { version: number } | undefined;
        expect(memoryIntentRow?.version).toBe(40);
        const memoryIntentClaimRow = db
          .prepare('SELECT version FROM schema_version WHERE version = 41')
          .get() as { version: number } | undefined;
        expect(memoryIntentClaimRow?.version).toBe(41);
        db.close();
      });

      it('upgrades existing migration 040 intent tables with the claim invariant', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-upgrade-040-'));
        const dbPath = join(tempDir, 'upgrade-040.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        setupDb.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            description TEXT
          );
          INSERT INTO schema_version (version, description)
          VALUES (40, 'Create operator memory commit intents');

          CREATE TABLE embeddings (
            rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
          );
          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL
          );
          CREATE TABLE memory_events (
            id INTEGER PRIMARY KEY,
            memory_id TEXT NOT NULL,
            topic TEXT,
            created_at INTEGER NOT NULL
          );

          CREATE TABLE operator_memory_commit_intents (
            intent_id TEXT PRIMARY KEY,
            cursor_name TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0),
            memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%'),
            memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json)),
            source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
            status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted')),
            claim_token TEXT,
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
          );
          CREATE INDEX idx_operator_memory_commit_intents_cursor_created
            ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);

          INSERT INTO operator_memory_commit_intents (
            intent_id, cursor_name, idempotency_key, expected_memory_count,
            memory_payload_hash, memory_ids_json, source_refs_json, status, claim_token,
            created_at_ms, updated_at_ms
          )
          VALUES
            (
              'intent:legacy-saving-without-claim',
              'connector:slack:channel:C_PUBLIC_SYNTHETIC',
              'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
              1,
              'sha256:legacy-saving-without-claim',
              '[null]',
              '["raw:slack:synthetic-event-index-id"]',
              'saving',
              NULL,
              1710000000000,
              1710000000000
            ),
            (
              'intent:legacy-pending-with-claim',
              'connector:slack:channel:C_PUBLIC_SYNTHETIC',
              'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
              1,
              'sha256:legacy-pending-with-claim',
              '[null]',
              '["raw:slack:synthetic-event-index-id"]',
              'pending',
              'claim:legacy',
              1710000000000,
              1710000000000
            );
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        const sql = tableSql(db, 'operator_memory_commit_intents');
        expect(sql).toContain("(status = 'saving' AND claim_token IS NOT NULL)");
        expect(sql).toContain("(status != 'saving' AND claim_token IS NULL)");
        expect(
          db
            .prepare(
              `SELECT status, claim_token
               FROM operator_memory_commit_intents
               WHERE intent_id = 'intent:legacy-saving-without-claim'`
            )
            .get()
        ).toEqual({ status: 'pending', claim_token: null });
        expect(
          db
            .prepare(
              `SELECT status, claim_token
               FROM operator_memory_commit_intents
               WHERE intent_id = 'intent:legacy-pending-with-claim'`
            )
            .get()
        ).toEqual({ status: 'pending', claim_token: null });
        const row = db.prepare('SELECT version FROM schema_version WHERE version = 41').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(41);
        db.close();
      });

      it('rejects partial operator memory intent tables when schema_version is already newer', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-partial-040-'));
        const dbPath = join(tempDir, 'partial-040.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        setupDb.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            description TEXT
          );
          INSERT INTO schema_version (version, description)
          VALUES (58, 'Legacy branch migration ahead of operator memory intents');

          CREATE TABLE embeddings (
            rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
          );
          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL
          );
          CREATE TABLE memory_events (
            id INTEGER PRIMARY KEY,
            memory_id TEXT NOT NULL,
            topic TEXT,
            created_at INTEGER NOT NULL
          );

          CREATE TABLE operator_memory_commit_intents (
            intent_id TEXT PRIMARY KEY,
            cursor_name TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            expected_memory_count INTEGER NOT NULL,
            memory_payload_hash TEXT NOT NULL,
            memory_ids_json TEXT NOT NULL,
            source_refs_json TEXT NOT NULL,
            status TEXT NOT NULL,
            claim_token TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(
          /incompatible operator_memory_commit_intents table definition/i
        );
        adapter.disconnect();
      });
    });
  });
});
