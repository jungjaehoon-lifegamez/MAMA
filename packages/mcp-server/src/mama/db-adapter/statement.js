/**
 * Unified Statement Interface
 *
 * Wraps database-specific prepared statements to provide consistent API
 * Compatible with better-sqlite3 and pg
 *
 * @module statement
 */

/**
 * Base statement interface
 * All statement wrappers must implement these methods
 */
class Statement {
  /**
   * Execute statement and return all rows
   * @param {...*} _params - Query parameters
   * @returns {Array<Object>} All matching rows
   */
  all(..._params) {
    throw new Error('all() must be implemented by subclass');
  }

  /**
   * Execute statement and return first row
   * @param {...*} _params - Query parameters
   * @returns {Object|undefined} First matching row or undefined
   */
  get(..._params) {
    throw new Error('get() must be implemented by subclass');
  }

  /**
   * Execute statement without returning rows
   * @param {...*} _params - Query parameters
   * @returns {Object} Execution info (changes, lastInsertRowid)
   */
  run(..._params) {
    throw new Error('run() must be implemented by subclass');
  }

  /**
   * Release statement resources
   */
  finalize() {
    // Optional: Some drivers don't require cleanup
  }
}

/**
 * SQLite statement wrapper (better-sqlite3)
 */
class SQLiteStatement extends Statement {
  constructor(stmt) {
    super();
    this.stmt = stmt;
  }

  all(...params) {
    return this.stmt.all(...params);
  }

  get(...params) {
    return this.stmt.get(...params);
  }

  run(...params) {
    return this.stmt.run(...params);
  }

  finalize() {
    // better-sqlite3 statements don't need explicit cleanup
  }
}

/**
 * PostgreSQL statement wrapper (pg)
 *
 * Maps pg's async query interface to synchronous-like API
 * Note: This requires careful handling in the adapter
 */
class PostgreSQLStatement extends Statement {
  constructor(client, sql, paramMapping) {
    super();
    this.client = client;
    this.sql = sql;
    this.paramMapping = paramMapping; // Map ? placeholders to $1, $2, etc.
  }

  /**
   * Convert SQLite ? placeholders to PostgreSQL $1, $2, ...
   * @param {string} sql - SQL with ? placeholders
   * @returns {string} SQL with $N placeholders
   */
  static convertPlaceholders(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  async all(...params) {
    const result = await this.client.query(this.sql, params);
    return result.rows;
  }

  async get(...params) {
    const result = await this.client.query(this.sql, params);
    return result.rows[0];
  }

  async run(...params) {
    const result = await this.client.query(this.sql, params);
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows[0]?.id || null, // PostgreSQL doesn't have rowid
    };
  }

  finalize() {
    // pg statements don't need explicit cleanup
  }
}

module.exports = {
  Statement,
  SQLiteStatement,
  PostgreSQLStatement,
};
