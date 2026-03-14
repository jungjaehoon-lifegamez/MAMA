#!/usr/bin/env node
/**
 * Compatibility wrapper kept for older docs/scripts.
 *
 * MAMA no longer installs better-sqlite3. SQLite comes from Node's built-in
 * `node:sqlite` runtime, so this helper now validates that the current Node.js
 * version exposes `node:sqlite` and reports a clear error otherwise.
 */

/**
 * Ensure Node's built-in SQLite runtime is available
 * @param {Object} options
 * @param {string} options.prefix - Log prefix (e.g., '[MAMA]')
 * @returns {boolean} - true if successful, false if failed
 */
function ensureSqliteRuntime(options = {}) {
  const prefix = options.prefix || '[MAMA]';

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    console.log(`${prefix} SQLite runtime: OK (node:sqlite)`);
    return true;
  } catch (err) {
    console.error(`${prefix} SQLite runtime unavailable:`, err.message);
    console.error(`${prefix} MAMA now requires Node.js 22+ with built-in node:sqlite.`);
    return false;
  }
}

// If run directly, execute the check and exit with appropriate code
if (require.main === module) {
  const success = ensureSqliteRuntime({ prefix: '[MAMA]' });
  if (!success) {
    process.exit(1);
  }
}

module.exports = {
  ensureSqliteRuntime,
  ensureSqlitePrebuild: ensureSqliteRuntime,
};
