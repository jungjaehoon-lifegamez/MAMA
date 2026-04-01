#!/usr/bin/env node
/**
 * Ensure better-sqlite3 is available.
 *
 * MAMA uses better-sqlite3 exclusively (FTS5 built-in, sync API, prebuild binaries).
 */

/**
 * Ensure better-sqlite3 is available
 * @param {Object} options
 * @param {string} options.prefix - Log prefix (e.g., '[MAMA]')
 * @returns {boolean} - true if successful, false if failed
 */
function ensureSqliteRuntime(options = {}) {
  const prefix = options.prefix || '[MAMA]';

  try {
    const BetterSqlite3 = require('better-sqlite3');
    const Ctor = BetterSqlite3.default || BetterSqlite3;
    const db = new Ctor(':memory:');
    db.close();
    console.log(`${prefix} SQLite runtime: OK (better-sqlite3)`);
    return true;
  } catch (err) {
    console.error(`${prefix} better-sqlite3 unavailable:`, err.message);
    console.error(`${prefix} Install it with: pnpm add better-sqlite3`);
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
