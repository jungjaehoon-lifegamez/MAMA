/**
 * Base Database Adapter Interface
 * All adapters must implement these methods
 */
class DatabaseAdapter {
  /**
   * Connect to database
   * @returns {Object} Database connection
   */
  connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from database
   */
  disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Check if connected
   * @returns {boolean} Connection status
   */
  isConnected() {
    throw new Error('isConnected() must be implemented by subclass');
  }

  /**
   * Prepare a SQL statement
   * @param {string} _sql - SQL query
   * @returns {Statement} Prepared statement
   */
  prepare(_sql) {
    throw new Error('prepare() must be implemented by subclass');
  }

  /**
   * Execute raw SQL
   * @param {string} _sql - SQL to execute
   */
  exec(_sql) {
    throw new Error('exec() must be implemented by subclass');
  }

  /**
   * Execute function in transaction
   * @param {Function} _fn - Function to execute
   * @returns {*} Function return value
   */
  transaction(_fn) {
    throw new Error('transaction() must be implemented by subclass');
  }

  /**
   * Vector similarity search
   * @param {number[]} _embedding - Query embedding (384-dim)
   * @param {number} _limit - Max results
   * @returns {Array<Object>} Search results with distance
   */
  vectorSearch(_embedding, _limit) {
    throw new Error('vectorSearch() must be implemented by subclass');
  }

  /**
   * Insert vector embedding
   * @param {number} _rowid - Decision rowid
   * @param {number[]} _embedding - Embedding vector
   */
  insertEmbedding(_rowid, _embedding) {
    throw new Error('insertEmbedding() must be implemented by subclass');
  }

  /**
   * Get last inserted row ID
   * @returns {number} Last rowid
   */
  getLastInsertRowid() {
    throw new Error('getLastInsertRowid() must be implemented by subclass');
  }

  /**
   * Run migrations
   * @param {string} _migrationsDir - Path to migrations directory
   */
  runMigrations(_migrationsDir) {
    throw new Error('runMigrations() must be implemented by subclass');
  }
}

module.exports = { DatabaseAdapter };
