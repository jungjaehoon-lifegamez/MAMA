/**
 * SQLite Database Adapter using better-sqlite3
 *
 * better-sqlite3 is the sole driver — FTS5 built-in, synchronous API,
 * prebuild binaries for most platforms.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { DatabaseAdapter, type VectorSearchResult, type RunResult } from './base-adapter.js';
import { SQLiteStatement, type Statement } from './statement.js';
import { info, warn, error as logError } from '../debug-logger.js';
import { cosineSimilarity } from '../embeddings.js';

const LEGACY_DB_PATH = path.join(os.homedir(), '.spinelift', 'memories.db');
const DEFAULT_DB_PATH = path.join(os.homedir(), '.claude', 'mama-memory.db');

interface SQLiteAdapterConfig {
  dbPath?: string;
}

interface BetterSQLite3Database {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): BetterSQLite3Statement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

interface BetterSQLite3Statement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

type BetterSQLite3Ctor = new (path: string) => BetterSQLite3Database;

let BetterSQLite3: BetterSQLite3Ctor | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs3 = require('better-sqlite3') as BetterSQLite3Ctor | { default: BetterSQLite3Ctor };
  BetterSQLite3 = 'default' in bs3 ? bs3.default : bs3;
} catch {
  BetterSQLite3 = null;
}

class BetterSQLite3Connection {
  private db: BetterSQLite3Database;
  private connected = true;

  constructor(db: BetterSQLite3Database) {
    this.db = db;
  }

  prepare(sql: string): BetterSQLite3Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const query = sql.trim().replace(/^PRAGMA\s+/i, '');
    return this.db.pragma(query, options);
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
  private db: BetterSQLite3Connection | null = null;
  private _vectorSearchEnabled = true;
  private vectorCache: Map<number, Float32Array> = new Map();
  private topicCache: Map<number, string> = new Map();
  /** Maps decision id (string) -> set of scope_id strings for pre-filtering */
  private scopeBindingsCache: Map<string, Set<string>> = new Map();
  /** Maps embedding rowid -> decision id for scope lookups */
  private rowidToDecisionId: Map<number, string> = new Map();

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

  connect(): BetterSQLite3Connection {
    if (this.db) {
      return this.db;
    }

    if (!BetterSQLite3) {
      throw new Error('better-sqlite3 is not installed. Run: pnpm add better-sqlite3');
    }

    const dbPath = this.getDbPath();
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      info(`[sqlite-adapter] Created database directory: ${dbDir}`);
    }

    const database = new BetterSQLite3(dbPath);
    this.db = new BetterSQLite3Connection(database);
    info(`[sqlite-adapter] Opened database at: ${dbPath} (driver: better-sqlite3)`);

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

  /**
   * Incrementally update scope bindings cache when a new binding is added.
   * Avoids full cache reload for single binding inserts.
   */
  addScopeBinding(memoryId: string, scopeId: string): void {
    let scopeSet = this.scopeBindingsCache.get(memoryId);
    if (!scopeSet) {
      scopeSet = new Set();
      this.scopeBindingsCache.set(memoryId, scopeSet);
    }
    scopeSet.add(scopeId);
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
    this.rowidToDecisionId.clear();
    const topicRows = this.db.prepare('SELECT rowid, id, topic FROM decisions').all() as Array<{
      rowid: number;
      id: string;
      topic: string;
    }>;
    for (const row of topicRows) {
      this.topicCache.set(row.rowid, row.topic);
      this.rowidToDecisionId.set(row.rowid, row.id);
    }

    // Load scope bindings cache for scope-filtered vector search
    this.scopeBindingsCache.clear();
    try {
      const bindingTableCheck = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scope_bindings'`
        )
        .all() as Array<{ name: string }>;

      if (bindingTableCheck.length > 0) {
        const bindingRows = this.db
          .prepare('SELECT memory_id, scope_id FROM memory_scope_bindings')
          .all() as Array<{ memory_id: string; scope_id: string }>;
        for (const row of bindingRows) {
          let scopeSet = this.scopeBindingsCache.get(row.memory_id);
          if (!scopeSet) {
            scopeSet = new Set();
            this.scopeBindingsCache.set(row.memory_id, scopeSet);
          }
          scopeSet.add(row.scope_id);
        }
      }
    } catch {
      // memory_scope_bindings may not exist yet — gracefully degrade
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
    return new SQLiteStatement(this.db.prepare(sql));
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
    topicPrefix?: string,
    scopeFilter?: { scopeIds: string[] }
  ): VectorSearchResult[] | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const queryVector =
      embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);

    const effectiveLimit = Math.max(limit, 1);
    const bestMatches: VectorSearchResult[] = [];
    let minScore = -Infinity;

    // Explicit empty scope filter = no matches possible
    if (scopeFilter && (!scopeFilter.scopeIds || scopeFilter.scopeIds.length === 0)) {
      return [];
    }
    // Pre-compute scope filter set for O(1) lookups
    const scopeIdSet = scopeFilter?.scopeIds?.length ? new Set(scopeFilter.scopeIds) : null;

    for (const [rowid, candidate] of this.vectorCache) {
      if (candidate.length !== queryVector.length) continue;

      // Pre-filter by topic prefix before computing similarity
      if (topicPrefix) {
        const topic = this.topicCache.get(rowid);
        if (!topic || !topic.startsWith(topicPrefix)) continue;
      }

      // Pre-filter by scope bindings before computing similarity
      if (scopeIdSet) {
        const decisionId = this.rowidToDecisionId.get(rowid);
        if (!decisionId) continue;
        const boundScopes = this.scopeBindingsCache.get(decisionId);
        // No bindings means not in any scope — exclude
        if (!boundScopes || boundScopes.size === 0) continue;
        // Must match at least one requested scope
        let hasMatch = false;
        for (const sid of scopeIdSet) {
          if (boundScopes.has(sid)) {
            hasMatch = true;
            break;
          }
        }
        if (!hasMatch) continue;
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
    const decisionRow = this.prepare('SELECT id, topic FROM decisions WHERE rowid = ?').get(
      rowid
    ) as { id: string; topic: string } | undefined;
    if (decisionRow) {
      this.topicCache.set(rowid, decisionRow.topic);
      this.rowidToDecisionId.set(rowid, decisionRow.id);
    }

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
