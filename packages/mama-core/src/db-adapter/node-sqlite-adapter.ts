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

let DatabaseSync: NodeSQLiteDatabaseCtor | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: NodeSQLiteDatabaseCtor;
  });
} catch {
  DatabaseSync = null;
}

class NodeSQLiteConnection {
  private db: NodeSQLiteDatabaseLike;
  private connected = true;

  constructor(db: NodeSQLiteDatabaseLike) {
    this.db = db;
  }

  prepare(sql: string): NodeSQLiteStatementLike {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const query = sql.trim().replace(/^PRAGMA\s+/i, '');
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

    if (!DatabaseSync) {
      throw new Error('node:sqlite is not available in this Node.js runtime. Use Node 22.13+.');
    }

    const dbPath = this.getDbPath();
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      info(`[node-sqlite-adapter] Created database directory: ${dbDir}`);
    }

    const database = new DatabaseSync(dbPath);
    this.db = new NodeSQLiteConnection(database);
    info(`[node-sqlite-adapter] Opened database at: ${dbPath}`);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');

    info('[node-sqlite-adapter] Vector search: pure TS cosine similarity (no native extensions)');

    return this.db;
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
        this.exec('ROLLBACK');
        throw new Error('DatabaseAdapter.transaction() callbacks must be synchronous');
      }
      this.exec('COMMIT');
      return result;
    } catch (error) {
      this.exec('ROLLBACK');
      throw error;
    }
  }

  vectorSearch(embedding: Float32Array | number[], limit = 5): VectorSearchResult[] | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const queryVector =
      embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);

    const tableCheck = this.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`
    ).all() as Array<{ name: string }>;

    if (tableCheck.length === 0) {
      throw new Error('Embeddings table missing');
    }

    const effectiveLimit = Math.max(limit, 1);
    const batchSize = 500;
    const bestMatches: VectorSearchResult[] = [];
    let offset = 0;

    let hasMoreRows = true;
    while (hasMoreRows) {
      const rows = this.prepare('SELECT rowid, embedding FROM embeddings LIMIT ? OFFSET ?').all(
        batchSize,
        offset
      ) as Array<{
        rowid: number;
        embedding: Uint8Array;
      }>;

      if (rows.length === 0) {
        hasMoreRows = false;
        continue;
      }

      for (const row of rows) {
        const candidate = bytesToVector(row.embedding);
        if (!candidate) continue;
        if (candidate.length !== queryVector.length) {
          warn(
            `Skipping rowid ${row.rowid}: dimension mismatch (${candidate.length} vs ${queryVector.length})`
          );
          continue;
        }

        const similarity = cosineSimilarity(candidate, queryVector);
        const scoredRow: VectorSearchResult = {
          rowid: row.rowid,
          similarity,
          distance: 1 - similarity,
        };

        if (bestMatches.length < effectiveLimit) {
          bestMatches.push(scoredRow);
          bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
          continue;
        }

        const weakestMatch = bestMatches[bestMatches.length - 1];
        if ((scoredRow.similarity ?? 0) > (weakestMatch.similarity ?? 0)) {
          bestMatches.pop();
          bestMatches.push(scoredRow);
          bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        }
      }

      offset += rows.length;
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

    return stmt.run(rowid, buffer);
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
      warn(
        '[node-sqlite-adapter] Embeddings migration missing; creating embeddings table as defensive fallback'
      );
      this.exec(`
        CREATE TABLE embeddings (
          rowid INTEGER PRIMARY KEY,
          embedding BLOB NOT NULL
        )
      `);
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
