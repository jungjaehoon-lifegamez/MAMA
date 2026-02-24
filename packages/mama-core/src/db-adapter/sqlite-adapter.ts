/**
 * SQLite Database Adapter
 *
 * Implements DatabaseAdapter interface using better-sqlite3
 * Vector search uses pure TypeScript brute-force cosine similarity (no native extensions)
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
  private _vectorSearchEnabled = true; // Always true: pure TS cosine similarity

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

    info('[sqlite-adapter] Vector search: pure TS cosine similarity (no native extensions)');

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
   * Vector similarity search using brute-force cosine similarity
   * Loads all embeddings from the embeddings table, computes similarity in JS,
   * and returns top-N results sorted by similarity descending.
   */
  vectorSearch(embedding: Float32Array | number[], limit = 5): VectorSearchResult[] | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const queryVector =
      embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);

    // Check if embeddings table exists
    const tableCheck = this.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`
    ).all() as Array<{ name: string }>;

    if (tableCheck.length === 0) {
      throw new Error('Embeddings table missing');
    }

    const rows = this.prepare('SELECT rowid, embedding FROM embeddings').all() as Array<{
      rowid: number;
      embedding: Buffer;
    }>;

    const scored: VectorSearchResult[] = [];
    for (const row of rows) {
      const candidate = bufferToVector(row.embedding);
      if (!candidate) continue;
      if (candidate.length !== queryVector.length) {
        warn(
          `Skipping rowid ${row.rowid}: dimension mismatch (${candidate.length} vs ${queryVector.length})`
        );
        continue;
      }
      const similarity = cosineSimilarity(candidate, queryVector);
      scored.push({
        rowid: row.rowid,
        similarity,
        distance: 1 - similarity,
      });
    }

    // Sort by similarity descending, return top-N
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    return scored.slice(0, Math.max(limit, 1));
  }

  /**
   * Insert vector embedding into the embeddings table (plain BLOB storage)
   */
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

  /**
   * Get last inserted row ID
   */
  getLastInsertRowid(): number {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    // better-sqlite3 provides this via Database instance
    const result = this.db.prepare('SELECT last_insert_rowid() as rowid').get() as {
      rowid: number;
    };
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
      const version = this.prepare('SELECT MAX(version) as version FROM schema_version').get() as
        | {
            version: number | null;
          }
        | undefined;
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

    // Ensure embeddings table exists (plain table, no native extensions)
    const embeddingsTables = this.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`
    ).all() as Array<{ name: string }>;

    if (embeddingsTables.length === 0) {
      info('[sqlite-adapter] Creating embeddings table');
      this.exec(`
        CREATE TABLE embeddings (
          rowid INTEGER PRIMARY KEY,
          embedding BLOB NOT NULL
        )
      `);
    }

    // Always attempt migration — uses INSERT OR IGNORE so safe to run multiple times
    this._migrateFromVssMemories();
  }

  /**
   * Attempt to migrate data from legacy vss_memories (sqlite-vec) to embeddings table.
   * This is best-effort: if sqlite-vec is not loaded, the vss_memories table won't be readable.
   */
  private _migrateFromVssMemories(): void {
    try {
      const vssTables = this.prepare(
        `SELECT name FROM sqlite_master WHERE name='vss_memories'`
      ).all() as Array<{ name: string }>;

      if (vssTables.length === 0) {
        return; // No legacy table
      }

      // Try to read from vss_memories — will fail if sqlite-vec extension isn't loaded
      const rows = this.prepare('SELECT rowid, embedding FROM vss_memories').all() as Array<{
        rowid: number;
        embedding: Buffer;
      }>;

      if (rows.length > 0) {
        const insertStmt = this.prepare(
          'INSERT OR IGNORE INTO embeddings (rowid, embedding) VALUES (?, ?)'
        );
        let migrated = 0;
        for (const row of rows) {
          const res = insertStmt.run(row.rowid, row.embedding);
          if (res.changes > 0) migrated++;
        }
        info(`[sqlite-adapter] Migrated ${migrated} embeddings from vss_memories to embeddings`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(
        `[sqlite-adapter] Could not migrate from vss_memories (expected if sqlite-vec not installed): ${message}`
      );
    }
  }
}

export default SQLiteAdapter;

function bufferToVector(buffer: Buffer | null): Float32Array | null {
  if (!buffer || buffer.byteLength % 4 !== 0) {
    return null;
  }
  try {
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    return new Float32Array(arrayBuffer);
  } catch {
    return null;
  }
}
