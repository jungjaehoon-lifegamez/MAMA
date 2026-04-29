/**
 * SQLite Database Adapter using node:sqlite
 *
 * Keeps the existing DatabaseAdapter surface while avoiding external native addon installation.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { DatabaseAdapter, type VectorSearchResult, type RunResult } from './base-adapter.js';
import { NodeSQLiteStatement } from './node-sqlite-statement.js';
import { type Statement } from './statement.js';
import { info, warn, error as logError } from '../debug-logger.js';
import { cosineSimilarity } from '../embeddings.js';

const LEGACY_DB_PATH = path.join(os.homedir(), '.spinelift', 'memories.db');
const DEFAULT_DB_PATH = path.join(os.homedir(), '.claude', 'mama-memory.db');
const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SQLiteAdapterConfig {
  dbPath?: string;
}

interface NodeSQLiteDatabaseLike {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): NodeSQLiteStatementLike;
}

interface NodeSQLiteStatementLike {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

type NodeSQLiteDatabaseCtor = new (path: string) => NodeSQLiteDatabaseLike;

// Prefer better-sqlite3 (includes FTS5) over node:sqlite (lacks FTS5)
let BetterSQLite3: NodeSQLiteDatabaseCtor | null = null;
let DatabaseSync: NodeSQLiteDatabaseCtor | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs3 = require('better-sqlite3') as
    | NodeSQLiteDatabaseCtor
    | { default: NodeSQLiteDatabaseCtor };
  BetterSQLite3 = 'default' in bs3 ? bs3.default : bs3;
} catch {
  BetterSQLite3 = null;
}

if (!BetterSQLite3) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: NodeSQLiteDatabaseCtor;
    });
  } catch {
    DatabaseSync = null;
  }
}

class NodeSQLiteConnection {
  private db: NodeSQLiteDatabaseLike;
  private connected = true;
  private isBetterSQLite3: boolean;

  constructor(db: NodeSQLiteDatabaseLike) {
    this.db = db;
    // better-sqlite3 databases have a native .pragma() method
    this.isBetterSQLite3 = typeof (db as unknown as Record<string, unknown>).pragma === 'function';
  }

  prepare(sql: string): NodeSQLiteStatementLike {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const query = sql.trim().replace(/^PRAGMA\s+/i, '');

    if (this.isBetterSQLite3) {
      // better-sqlite3 has a native pragma method that handles both read and write pragmas
      return (this.db as unknown as Record<string, (...args: unknown[]) => unknown>).pragma(
        query,
        options
      );
    }

    // node:sqlite fallback: use prepare()
    const stmt = this.db.prepare(`PRAGMA ${query}`);
    if (options?.simple) {
      const row = stmt.get() as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      return Object.values(row)[0];
    }
    return stmt.all();
  }

  close(): void {
    if (!this.connected) {
      return;
    }
    this.db.close();
    this.connected = false;
  }

  get open(): boolean {
    return this.connected;
  }
}

export class NodeSQLiteAdapter extends DatabaseAdapter {
  private config: SQLiteAdapterConfig;
  private db: NodeSQLiteConnection | null = null;
  private _vectorSearchEnabled = true;
  private vectorCache: Map<number, Float32Array> = new Map();
  private topicCache: Map<number, string> = new Map();

  constructor(config: SQLiteAdapterConfig = {}) {
    super();
    this.config = config;
  }

  get vectorSearchEnabled(): boolean {
    return this._vectorSearchEnabled;
  }

  getDbPath(): string {
    const envPath = process.env.MAMA_DB_PATH || process.env.MAMA_DATABASE_PATH;
    const configPath = this.config.dbPath;

    let expandedEnvPath = envPath;
    if (envPath) {
      expandedEnvPath = envPath.replace(/\$\{HOME\}/g, os.homedir()).replace(/^~/, os.homedir());
    }

    const targetPath = configPath || expandedEnvPath || DEFAULT_DB_PATH;

    if (!configPath && !envPath && fs.existsSync(LEGACY_DB_PATH)) {
      info(
        '[node-sqlite-adapter] Found legacy database at ~/.spinelift/memories.db, using it for backward compatibility'
      );
      return LEGACY_DB_PATH;
    }

    return targetPath;
  }

  connect(): NodeSQLiteConnection {
    if (this.db) {
      return this.db;
    }

    const Driver = BetterSQLite3 || DatabaseSync;
    if (!Driver) {
      throw new Error(
        'No SQLite driver available. Install better-sqlite3 or use Node 22.13+ (node:sqlite).'
      );
    }

    const driverName = BetterSQLite3 ? 'better-sqlite3' : 'node:sqlite';

    const dbPath = this.getDbPath();
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      info(`[sqlite-adapter] Created database directory: ${dbDir}`);
    }

    const database = new Driver(dbPath);
    this.db = new NodeSQLiteConnection(database);
    info(`[sqlite-adapter] Opened database at: ${dbPath} (driver: ${driverName})`);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');

    info('[sqlite-adapter] Vector search: pure TS cosine similarity (no native extensions)');

    this.loadVectorCache();

    return this.db;
  }

  reloadVectorCache(): void {
    this.loadVectorCache();
  }

  private loadVectorCache(): void {
    if (!this.db) return;

    const tableCheck = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`)
      .all() as Array<{ name: string }>;

    if (tableCheck.length === 0) {
      this.vectorCache.clear();
      this.topicCache.clear();
      return;
    }

    const start = Date.now();
    const rows = this.db.prepare('SELECT rowid, embedding FROM embeddings').all() as Array<{
      rowid: number;
      embedding: Uint8Array;
    }>;

    const CACHE_WARN_THRESHOLD = 100_000;
    this.vectorCache.clear();
    for (const row of rows) {
      const vec = bytesToVector(row.embedding);
      if (vec) {
        this.vectorCache.set(row.rowid, vec);
      }
    }

    // Load topic cache for scoped vector search
    this.topicCache.clear();
    const topicRows = this.db.prepare('SELECT rowid, topic FROM decisions').all() as Array<{
      rowid: number;
      topic: string;
    }>;
    for (const row of topicRows) {
      this.topicCache.set(row.rowid, row.topic);
    }

    const count = this.vectorCache.size;
    const elapsed = Date.now() - start;
    info(`[node-sqlite-adapter] Vector cache loaded: ${count} embeddings in ${elapsed}ms`);
    if (count > CACHE_WARN_THRESHOLD) {
      warn(
        `[node-sqlite-adapter] Vector cache holds ${count} embeddings — consider LRU eviction or on-demand loading for large datasets`
      );
    }
  }

  disconnect(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      info('[node-sqlite-adapter] Disconnected from database');
    }
  }

  isConnected(): boolean {
    return this.db !== null && this.db.open;
  }

  prepare(sql: string): Statement {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    return new NodeSQLiteStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    this.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      if (
        ((typeof result === 'object' && result !== null) || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        throw new Error('DatabaseAdapter.transaction() callbacks must be synchronous');
      }
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // Preserve the original transaction failure when rollback also fails.
      }
      throw error;
    }
  }

  vectorSearch(
    embedding: Float32Array | number[],
    limit = 5,
    topicPrefix?: string
  ): VectorSearchResult[] | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const queryVector =
      embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);

    const effectiveLimit = Math.max(limit, 1);
    const bestMatches: VectorSearchResult[] = [];
    let minScore = -Infinity;

    for (const [rowid, candidate] of this.vectorCache) {
      if (candidate.length !== queryVector.length) continue;

      // Pre-filter by topic prefix before computing similarity
      if (topicPrefix) {
        const topic = this.topicCache.get(rowid);
        if (!topic || !topic.startsWith(topicPrefix)) continue;
      }

      const similarity = cosineSimilarity(candidate, queryVector);

      if (bestMatches.length < effectiveLimit) {
        bestMatches.push({ rowid, similarity, distance: 1 - similarity });
        if (bestMatches.length === effectiveLimit) {
          bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
          minScore = bestMatches[bestMatches.length - 1].similarity ?? -Infinity;
        }
      } else if (similarity > minScore) {
        bestMatches[bestMatches.length - 1] = { rowid, similarity, distance: 1 - similarity };
        bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        minScore = bestMatches[bestMatches.length - 1].similarity ?? -Infinity;
      }
    }

    if (bestMatches.length < effectiveLimit) {
      bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    }

    return bestMatches;
  }

  insertEmbedding(rowid: number, embedding: Float32Array | number[]): RunResult | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const vec = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
    const buffer = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

    const stmt = this.prepare(`
      INSERT OR REPLACE INTO embeddings(rowid, embedding)
      VALUES (?, ?)
    `);

    const result = stmt.run(rowid, buffer);

    // Keep in-memory caches in sync
    this.vectorCache.set(rowid, vec);
    const topicRow = this.prepare('SELECT topic FROM decisions WHERE rowid = ?').get(rowid) as
      | { topic: string }
      | undefined;
    if (topicRow) this.topicCache.set(rowid, topicRow.topic);

    return result;
  }

  getLastInsertRowid(): number {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    const result = this.prepare('SELECT last_insert_rowid() as rowid').get() as {
      rowid: number;
    };
    return result.rowid;
  }

  runMigrations(migrationsDir: string): void {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const tables = this.prepare(
      `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='schema_version'
    `
    ).all() as Array<{ name: string }>;

    let currentVersion = 0;
    if (tables.length > 0) {
      const version = this.prepare('SELECT MAX(version) as version FROM schema_version').get() as
        | { version: number | null }
        | undefined;
      currentVersion = version?.version || 0;
    }

    info(`[node-sqlite-adapter] Current schema version: ${currentVersion}`);

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const versionMatch = file.match(/^(\d+)-/);
      if (!versionMatch) {
        continue;
      }

      const version = parseInt(versionMatch[1], 10);
      if (version <= currentVersion) {
        continue;
      }

      const migrationPath = path.join(migrationsDir, file);
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

      info(`[node-sqlite-adapter] Applying migration: ${file}`);

      try {
        this.exec('BEGIN TRANSACTION');
        this.exec(migrationSQL);
        this.exec('COMMIT');
        this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
        info(`[node-sqlite-adapter] Migration ${file} applied successfully`);
      } catch (err) {
        this.exec('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('duplicate column') && version === 32) {
          this.recoverMemoryProvenanceMigration032();
          info(`[node-sqlite-adapter] Migration ${file} recovered successfully`);
          continue;
        }

        if (message.includes('duplicate column') && version === 34) {
          this.recoverConnectorEventScopeMigration034();
          info(`[node-sqlite-adapter] Migration ${file} recovered successfully`);
          continue;
        }

        if (message.includes('duplicate column')) {
          warn(
            `[node-sqlite-adapter] Migration ${file} skipped (duplicate column - already applied)`
          );
          this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
          continue;
        }

        if (message.includes('no such table')) {
          const hasAlterTable = migrationSQL.toUpperCase().includes('ALTER TABLE');
          if (!hasAlterTable) {
            logError(
              `[node-sqlite-adapter] Migration ${file} failed (missing required table):`,
              err
            );
            throw new Error(`Migration ${file} failed: ${message}`);
          }
          warn(
            `[node-sqlite-adapter] Migration ${file} skipped: ALTER TABLE on non-existent table (${message})`
          );
          this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
          continue;
        }

        logError(`[node-sqlite-adapter] Migration ${file} failed:`, err);
        throw new Error(`Migration ${file} failed: ${message}`);
      }
    }

    const embeddingsTables = this.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`
    ).all() as Array<{ name: string }>;

    if (embeddingsTables.length === 0) {
      throw new Error(
        'Embeddings table is missing after migrations. Add the required embeddings migration.'
      );
    }

    this.migrateFromVssMemories();
  }

  private recoverMemoryProvenanceMigration032(): void {
    this.transaction(() => {
      const expectedDecisionColumns = [
        'agent_id',
        'model_run_id',
        'envelope_hash',
        'gateway_call_id',
        'source_refs_json',
        'provenance_json',
      ];
      const decisionColumns = this.tableColumns('decisions');
      for (const column of expectedDecisionColumns) {
        if (!decisionColumns.has(column)) {
          this.exec(`ALTER TABLE decisions ADD COLUMN ${column} TEXT`);
          decisionColumns.add(column);
        }
      }

      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_decisions_envelope_hash
          ON decisions(envelope_hash)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_decisions_model_run_id
          ON decisions(model_run_id)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_decisions_gateway_call_id
          ON decisions(gateway_call_id)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_events_memory_created
          ON memory_events(memory_id, created_at DESC)
      `);

      this.assertMigration032Complete();
      this.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
        32,
        'Add nullable memory provenance columns'
      );
    });
  }

  private assertMigration032Complete(): void {
    const decisionColumns = this.tableColumns('decisions');
    for (const column of [
      'agent_id',
      'model_run_id',
      'envelope_hash',
      'gateway_call_id',
      'source_refs_json',
      'provenance_json',
    ]) {
      if (!decisionColumns.has(column)) {
        throw new Error(`Migration 032 recovery failed: missing decisions.${column}`);
      }
    }

    for (const indexName of [
      'idx_decisions_envelope_hash',
      'idx_decisions_model_run_id',
      'idx_decisions_gateway_call_id',
      'idx_memory_events_memory_created',
    ]) {
      if (!this.indexExists(indexName)) {
        throw new Error(`Migration 032 recovery failed: missing index ${indexName}`);
      }
    }
  }

  private recoverConnectorEventScopeMigration034(): void {
    this.transaction(() => {
      const expectedColumns = [
        'source_cursor',
        'tenant_id',
        'project_id',
        'memory_scope_kind',
        'memory_scope_id',
      ];
      const columns = this.tableColumns('connector_event_index');
      for (const column of expectedColumns) {
        if (!columns.has(column)) {
          this.exec(`ALTER TABLE connector_event_index ADD COLUMN ${column} TEXT`);
          columns.add(column);
        }
      }

      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_connector_event_scope
          ON connector_event_index(tenant_id, project_id, memory_scope_kind, memory_scope_id)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_connector_event_source_cursor
          ON connector_event_index(source_connector, source_cursor)
      `);

      this.assertMigration034Complete();
      this.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
        34,
        'Add connector event scope columns'
      );
    });
  }

  private assertMigration034Complete(): void {
    const columns = this.tableColumns('connector_event_index');
    for (const column of [
      'source_cursor',
      'tenant_id',
      'project_id',
      'memory_scope_kind',
      'memory_scope_id',
    ]) {
      if (!columns.has(column)) {
        throw new Error(`Migration 034 recovery failed: missing connector_event_index.${column}`);
      }
    }

    for (const indexName of ['idx_connector_event_scope', 'idx_connector_event_source_cursor']) {
      if (!this.indexExists(indexName)) {
        throw new Error(`Migration 034 recovery failed: missing index ${indexName}`);
      }
    }
  }

  private tableColumns(tableName: string): Set<string> {
    if (!SQLITE_IDENTIFIER_PATTERN.test(tableName)) {
      throw new Error('Invalid SQLite table identifier');
    }

    const rows = this.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private indexExists(indexName: string): boolean {
    const row = this.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(
      indexName
    ) as { name?: string } | undefined;
    return row?.name === indexName;
  }

  private migrateFromVssMemories(): void {
    try {
      const vssTables = this.prepare(
        `SELECT name FROM sqlite_master WHERE name='vss_memories'`
      ).all() as Array<{ name: string }>;

      if (vssTables.length === 0) {
        return;
      }

      const rows = this.prepare('SELECT rowid, embedding FROM vss_memories').all() as Array<{
        rowid: number;
        embedding: Uint8Array;
      }>;

      if (rows.length > 0) {
        const insertStmt = this.prepare(
          'INSERT OR IGNORE INTO embeddings (rowid, embedding) VALUES (?, ?)'
        );
        let migrated = 0;
        for (const row of rows) {
          const res = insertStmt.run(row.rowid, Buffer.from(row.embedding));
          if (res.changes > 0) {
            migrated++;
          }
        }
        info(
          `[node-sqlite-adapter] Migrated ${migrated} embeddings from vss_memories to embeddings`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(
        `[node-sqlite-adapter] Could not migrate from vss_memories (expected if sqlite-vec not installed): ${message}`
      );
    }
  }
}

export default NodeSQLiteAdapter;

function bytesToVector(buffer: Uint8Array | Buffer | null): Float32Array | null {
  if (!buffer || buffer.byteLength % 4 !== 0) {
    return null;
  }

  try {
    const typedBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const arrayBuffer = typedBuffer.buffer.slice(
      typedBuffer.byteOffset,
      typedBuffer.byteOffset + typedBuffer.byteLength
    );
    return new Float32Array(arrayBuffer);
  } catch {
    return null;
  }
}
