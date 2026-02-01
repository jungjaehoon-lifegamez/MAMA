#!/usr/bin/env node
/**
 * Shared utility to ensure better-sqlite3 prebuild is installed
 *
 * This script is called by postinstall scripts in both:
 * - packages/mcp-server
 * - packages/openclaw-plugin
 *
 * It attempts to load better-sqlite3 and if it fails, runs prebuild-install
 * to download the appropriate prebuilt binary for the current Node.js version.
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * Ensure better-sqlite3 prebuild is installed
 * @param {Object} options
 * @param {string} options.prefix - Log prefix (e.g., '[MAMA]')
 * @returns {boolean} - true if successful, false if failed
 */
function ensureSqlitePrebuild(options = {}) {
  const prefix = options.prefix || '[MAMA]';

  try {
    require('better-sqlite3');
    console.log(`${prefix} SQLite native module: OK`);
    return true;
  } catch (err) {
    console.warn(`${prefix} SQLite native module not ready, installing prebuild...`);

    try {
      const betterSqlitePath = path.dirname(require.resolve('better-sqlite3/package.json'));

      // Try to use local prebuild-install first, fallback to npx
      let prebuildCmd = 'npx prebuild-install';
      try {
        const prebuildPath = require.resolve('prebuild-install/bin.js');
        prebuildCmd = `node "${prebuildPath}"`;
      } catch {
        // prebuild-install not installed locally, use npx
      }

      execSync(prebuildCmd, {
        cwd: betterSqlitePath,
        stdio: 'inherit',
      });

      // Clear require cache and retry
      try {
        delete require.cache[require.resolve('better-sqlite3')];
      } catch {
        // Module not in cache yet, that's fine
      }
      require('better-sqlite3');
      console.log(`${prefix} SQLite native module: OK (prebuild installed)`);
      return true;
    } catch (prebuildErr) {
      console.error(`${prefix} Failed to install prebuild:`, prebuildErr.message);
      console.error(
        `${prefix} Try manually: cd node_modules/better-sqlite3 && npx prebuild-install`
      );
      return false;
    }
  }
}

// If run directly, execute the check and exit with appropriate code
if (require.main === module) {
  const success = ensureSqlitePrebuild({ prefix: '[MAMA]' });
  if (!success) {
    process.exit(1);
  }
}

module.exports = { ensureSqlitePrebuild };
