/**
 * SQLite Database Adapter
 *
 * Implements DatabaseAdapter interface using better-sqlite3 + sqlite-vec
 * This is the current production implementation extracted from memory-store.js
 *
 * @module sqlite-adapter
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { DatabaseAdapter, type VectorSearchResult, type RunResult } from './base-adapter.js';
import { SQLiteStatement, type Statement } from './statement.js';
import { info, warn, error as logError } from '../debug-logger.js';
import { cosineSimilarity } from '../embeddings.js';

// Try to load sqlite-vec
let sqliteVec: { load: (db: Database.Database) => void } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqliteVec = require('sqlite-vec');
} catch {
  // Defer logging until connect() so we have logger context initialized
  sqliteVec = null;
}

// Database paths
const LEGACY_DB_PATH = path.join(os.homedir(), '.spinelift', 'memories.db');
// Default to ~/.claude/mama-memory.db for Claude Code/Desktop compatibility
const DEFAULT_DB_PATH = path.join(os.homedir(), '.claude', 'mama-memory.db');

/**
 * Adapter configuration
 */
interface SQLiteAdapterConfig {
  dbPath?: string;
}

export class SQLiteAdapter extends DatabaseAdapter {
  private config: SQLiteAdapterConfig;
  private db: Database.Database | null = null;
  private _vectorSearchEnabled = false;

  constructor(config: SQLiteAdapterConfig = {}) {
    super();
    this.config = config;
  }

  /**
   * Check if vector search is enabled
   */
  get vectorSearchEnabled(): boolean {
    return this._vectorSearchEnabled;
  }

  /**
   * Get database path with backward compatibility
   */
  getDbPath(): string {
    // Support both MAMA_DB_PATH and MAMA_DATABASE_PATH for backward compatibility
    const envPath = process.env.MAMA_DB_PATH || process.env.MAMA_DATABASE_PATH;
    const configPath = this.config.dbPath;

    // Expand ${HOME} or ~ in environment variable
    let expandedEnvPath = envPath;
    if (envPath) {
      expandedEnvPath = envPath.replace(/\$\{HOME\}/g, os.homedir()).replace(/^~/, os.homedir());
    }

    // Priority: config > env > default
    const targetPath = configPath || expandedEnvPath || DEFAULT_DB_PATH;

    // Backward compatibility: Check legacy path if not explicitly set
    if (!configPath && !envPath && fs.existsSync(LEGACY_DB_PATH)) {
      info(
        '[sqlite-adapter] Found legacy database at ~/.spinelift/memories.db, using it for backward compatibility'
      );
      return LEGACY_DB_PATH;
    }

    return targetPath;
  }

  /**
   * Connect to SQLite database
   */
  connect(): Database.Database {
    if (this.db) {
      return this.db;
    }

    const dbPath = this.getDbPath();
    const dbDir = path.dirname(dbPath);

    // Ensure directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      info(`[sqlite-adapter] Created database directory: ${dbDir}`);
    }

    // Open database
    this.db = new Database(dbPath, { verbose: undefined });
    info(`[sqlite-adapter] Opened database at: ${dbPath}`);

    // Production configuration
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB cache
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');

    // Load sqlite-vec extension (graceful degradation if unavailable)
    if (sqliteVec) {
      try {
        sqliteVec.load(this.db);
        this._vectorSearchEnabled = true;
        info('[sqlite-adapter] Loaded sqlite-vec extension');
      } catch (err) {
        this._vectorSearchEnabled = false;
        const message = err instanceof Error ? err.message : String(err);
        warn(`[sqlite-adapter] sqlite-vec unavailable (Tier 2 fallback): ${message}`);
      }
    } else {
      this._vectorSearchEnabled = false;
      warn('[sqlite-adapter] sqlite-vec package not installed; vector search disabled');
    }

    return this.db;
  }

  /**
   * Disconnect from database
   */
  disconnect(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      info('[sqlite-adapter] Disconnected from database');
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.db !== null && this.db.open;
  }

  /**
   * Prepare a SQL statement
   */
  prepare(sql: string): Statement {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    const stmt = this.db.prepare(sql);
    return new SQLiteStatement(stmt);
  }

  /**
   * Execute raw SQL
   */
  exec(sql: string): void {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    this.db.exec(sql);
  }

  /**
   * Execute function in transaction
   */
  transaction<T>(fn: () => T): T {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    const txn = this.db.transaction(fn);
    return txn();
  }

  /**
   * Vector similarity search using sqlite-vec (vec0 virtual table)
   */
  vectorSearch(embedding: Float32Array | number[], limit = 5): VectorSearchResult[] | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    if (!this._vectorSearchEnabled) {
      return null;
    }

    const embeddingJson = JSON.stringify(Array.from(embedding));
    const stmt = this.prepare(`
      SELECT
        rowid,
        embedding,
        distance
      FROM vss_memories
      WHERE embedding MATCH vec_f32(?)
      LIMIT ?
    `);

    const queryVector =
      embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
    const results = stmt.all(embeddingJson, Math.max(limit, 1)) as Array<{
      rowid: number;
      embedding: Buffer;
      distance: number;
    }>;

    return results
      .map((row): VectorSearchResult | null => {
        const candidate = bufferToVector(row.embedding);
        if (!candidate) {
          return null;
        }
        const similarity = cosineSimilarity(candidate, queryVector);
        return {
          rowid: row.rowid,
          similarity,
          distance: 1 - similarity,
        };
      })
      .filter((r): r is VectorSearchResult => r !== null);
  }

  /**
   * Insert vector embedding
   */
  insertEmbedding(rowid: number, embedding: Float32Array | number[]): RunResult | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    if (!this._vectorSearchEnabled) {
      return null;
    }

    const embeddingJson = JSON.stringify(Array.from(embedding));

    // CRITICAL FIX: sqlite-vec virtual tables accept rowid as literal but not via ? placeholder
    // Using template literal with Number() cast for safety (prevents SQL injection)
    const safeRowid = Number(rowid);
    if (!Number.isInteger(safeRowid) || safeRowid < 1) {
      throw new Error(`Invalid rowid: ${rowid}`);
    }

    const stmt = this.prepare(`
      INSERT OR REPLACE INTO vss_memories(rowid, embedding)
      VALUES (${safeRowid}, ?)
    `);

    return stmt.run(embeddingJson);
  }

  /**
   * Get last inserted row ID
   */
  getLastInsertRowid(): number {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    // better-sqlite3 provides this via Database instance
    const result = this.db.prepare('SELECT last_insert_rowid() as rowid').get() as { rowid: number };
    return result.rowid;
  }

  /**
   * Run migrations
   */
  runMigrations(migrationsDir: string): void {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    // Check if schema_version table exists
    const tables = this.prepare(
      `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='schema_version'
    `
    ).all() as Array<{ name: string }>;

    let currentVersion = 0;
    if (tables.length > 0) {
      const version = this.prepare('SELECT MAX(version) as version FROM schema_version').get() as {
        version: number | null;
      } | undefined;
      currentVersion = version?.version || 0;
    }

    info(`[sqlite-adapter] Current schema version: ${currentVersion}`);

    // Get all migration files
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    // Apply migrations
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

      info(`[sqlite-adapter] Applying migration: ${file}`);

      try {
        this.exec('BEGIN TRANSACTION');
        this.exec(migrationSQL);
        this.exec('COMMIT');

        // Record migration in schema_version table (outside transaction for idempotency)
        this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
        info(`[sqlite-adapter] Migration ${file} applied successfully`);
      } catch (err) {
        this.exec('ROLLBACK');

        const message = err instanceof Error ? err.message : String(err);

        // Handle duplicate column errors as idempotent (migration 003)
        if (message.includes('duplicate column')) {
          warn(`[sqlite-adapter] Migration ${file} skipped (duplicate column - already applied)`);
          // Record migration as applied
          this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
          continue;
        }

        if (message.includes('no such table')) {
          // Only skip if this migration contains an ALTER TABLE (adding column to optional table)
          // Note: migrationSQL may contain comments, so check if ALTER TABLE exists anywhere
          const hasAlterTable = migrationSQL.toUpperCase().includes('ALTER TABLE');
          if (!hasAlterTable) {
            logError(`[sqlite-adapter] Migration ${file} failed (missing required table):`, err);
            throw new Error(`Migration ${file} failed: ${message}`);
          }
          warn(
            `[sqlite-adapter] Migration ${file} skipped: ALTER TABLE on non-existent table (${message})`
          );
          this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
          continue;
        }

        logError(`[sqlite-adapter] Migration ${file} failed:`, err);
        throw new Error(`Migration ${file} failed: ${message}`);
      }
    }

    // Create vss_memories table if not exists
    if (this._vectorSearchEnabled) {
      const vssTables = this.prepare(
        `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='vss_memories'
      `
      ).all() as Array<{ name: string }>;

      if (vssTables.length === 0) {
        info('[sqlite-adapter] Creating vss_memories virtual table via sqlite-vec');
        this.exec(`
          CREATE VIRTUAL TABLE vss_memories USING vec0(
            embedding float[384]
          )
        `);
      }
    } else {
      warn('[sqlite-adapter] Skipping vss_memories creation (sqlite-vec unavailable)');
    }
  }
}

export default SQLiteAdapter;

function bufferToVector(buffer: Buffer | null): Float32Array | null {
  if (!buffer) {
    return null;
  }
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(arrayBuffer);
}
