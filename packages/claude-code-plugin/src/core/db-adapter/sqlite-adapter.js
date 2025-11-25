/**
 * SQLite Database Adapter
 *
 * Implements DatabaseAdapter interface using better-sqlite3 + sqlite-vec
 * This is the current production implementation extracted from memory-store.js
 *
 * @module sqlite-adapter
 */

const { DatabaseAdapter } = require('./base-adapter');
const { SQLiteStatement } = require('./statement');
const { info, warn, error: logError } = require('../debug-logger');
// Lazy-load cosineSimilarity to avoid triggering Transformers.js model loading
// const { cosineSimilarity } = require('../embeddings');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
let sqliteVec = null;

try {
  sqliteVec = require('sqlite-vec');
} catch (err) {
  // Defer logging until connect() so we have logger context initialized
  sqliteVec = null;
}

// Database paths
const LEGACY_DB_PATH = path.join(os.homedir(), '.spinelift', 'memories.db');
const DEFAULT_DB_PATH = path.join(os.homedir(), '.claude', 'mama-memory.db');

class SQLiteAdapter extends DatabaseAdapter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.db = null;
    this.lastRowid = null;
    this.vectorSearchEnabled = false;
  }

  /**
   * Get database path with backward compatibility
   */
  getDbPath() {
    const envPath = process.env.MAMA_DB_PATH;
    const configPath = this.config.dbPath;

    // Priority: config > env > default
    const targetPath = configPath || envPath || DEFAULT_DB_PATH;

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
  connect() {
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
    this.db = new Database(dbPath, { verbose: null });
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
        this.vectorSearchEnabled = true;
        info('[sqlite-adapter] Loaded sqlite-vec extension');
      } catch (err) {
        this.vectorSearchEnabled = false;
        warn(`[sqlite-adapter] sqlite-vec unavailable (Tier 2 fallback): ${err.message}`);
      }
    } else {
      this.vectorSearchEnabled = false;
      warn('[sqlite-adapter] sqlite-vec package not installed; vector search disabled');
    }

    return this.db;
  }

  /**
   * Disconnect from database
   */
  disconnect() {
    if (this.db) {
      this.db.close();
      this.db = null;
      info('[sqlite-adapter] Disconnected from database');
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.db !== null && this.db.open;
  }

  /**
   * Prepare a SQL statement
   */
  prepare(sql) {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    const stmt = this.db.prepare(sql);
    return new SQLiteStatement(stmt);
  }

  /**
   * Execute raw SQL
   */
  exec(sql) {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    return this.db.exec(sql);
  }

  /**
   * Execute function in transaction
   */
  transaction(fn) {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    const txn = this.db.transaction(fn);
    return txn();
  }

  /**
   * Vector similarity search using sqlite-vec (vec0 virtual table)
   */
  vectorSearch(embedding, limit = 5) {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    if (!this.vectorSearchEnabled) {
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
    const results = stmt.all(embeddingJson, Math.max(limit, 1));

    // Lazy-load cosineSimilarity only when vector search is actually needed
    const { cosineSimilarity } = require('../embeddings');

    return results
      .map((row) => {
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
      .filter(Boolean);
  }

  /**
   * Insert vector embedding
   */
  insertEmbedding(rowid, embedding) {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    if (!this.vectorSearchEnabled) {
      return null;
    }

    if (!embedding) {
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
      INSERT INTO vss_memories(rowid, embedding)
      VALUES (${safeRowid}, ?)
    `);

    return stmt.run(embeddingJson);
  }

  /**
   * Get last inserted row ID
   */
  getLastInsertRowid() {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    // better-sqlite3 provides this via Database instance
    return this.db.prepare('SELECT last_insert_rowid() as rowid').get().rowid;
  }

  /**
   * Run migrations
   */
  runMigrations(migrationsDir) {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    // Check if schema_version table exists
    const tables = this.prepare(
      `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='schema_version'
    `
    ).all();

    let currentVersion = 0;
    if (tables.length > 0) {
      const version = this.prepare('SELECT MAX(version) as version FROM schema_version').get();
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

        // Handle duplicate column errors as idempotent (migration 003)
        if (err.message && err.message.includes('duplicate column')) {
          warn(`[sqlite-adapter] Migration ${file} skipped (duplicate column - already applied)`);
          // Record migration as applied
          this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
          continue;
        }

        logError(`[sqlite-adapter] Migration ${file} failed:`, err);
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    // Create vss_memories table if not exists
    if (this.vectorSearchEnabled) {
      const vssTables = this.prepare(
        `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='vss_memories'
      `
      ).all();

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

module.exports = SQLiteAdapter;

function bufferToVector(buffer) {
  if (!buffer) {
    return null;
  }
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(arrayBuffer);
}
