/**
 * Database Adapter Factory (SQLite-only)
 *
 * MAMA Plugin uses SQLite exclusively for local storage.
 * PostgreSQL support is only available in the legacy mcp-server.
 *
 * @module db-adapter
 */

const { info } = require('../debug-logger');
const SQLiteAdapter = require('./sqlite-adapter');

/**
 * Create SQLite database adapter
 *
 * @param {Object} config - Database configuration
 * @param {string} [config.dbPath] - SQLite file path (overrides env)
 * @returns {DatabaseAdapter} Configured SQLite adapter instance
 */
function createAdapter(config = {}) {
  info('[db-adapter] Using SQLite adapter (plugin mode)');
  const dbPath = config.dbPath || process.env.MAMA_DB_PATH;
  return new SQLiteAdapter({ dbPath });
}

const { DatabaseAdapter } = require('./base-adapter');

module.exports = {
  createAdapter,
  DatabaseAdapter,
};
