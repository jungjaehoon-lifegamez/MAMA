#!/usr/bin/env node
/**
 * MAMA MCP Server - Postinstall Script
 * Ensures better-sqlite3 prebuild is installed correctly
 */

const { execSync } = require('child_process');
const path = require('path');

async function main() {
  console.log('[MAMA] Running postinstall checks...');

  // Check Node.js version
  const nodeVersion = process.versions.node.split('.')[0];
  if (parseInt(nodeVersion) < 18) {
    console.warn('[MAMA] Warning: Node.js 18+ recommended, current:', process.versions.node);
  }

  // Check better-sqlite3 and install prebuild if needed (uses shared utility)
  try {
    // Try to use shared utility first
    const sharedScript = path.resolve(__dirname, '../../../scripts/ensure-sqlite-prebuild.js');
    const { ensureSqlitePrebuild } = require(sharedScript);
    ensureSqlitePrebuild({ prefix: '[MAMA]' });
  } catch (sharedErr) {
    // Shared utility not available when installed from npm (monorepo structure not present).
    // Inline logic below mirrors scripts/ensure-sqlite-prebuild.js - keep in sync.
    try {
      require('better-sqlite3');
      console.log('[MAMA] SQLite native module: OK');
    } catch (err) {
      console.warn('[MAMA] SQLite native module not ready, installing prebuild...');

      try {
        const betterSqlitePath = path.dirname(require.resolve('better-sqlite3/package.json'));

        execSync('npx prebuild-install', { cwd: betterSqlitePath, stdio: 'inherit' });

        delete require.cache[require.resolve('better-sqlite3')];
        require('better-sqlite3');
        console.log('[MAMA] SQLite native module: OK (prebuild installed)');
      } catch (prebuildErr) {
        console.error('[MAMA] Failed to install prebuild:', prebuildErr.message);
        console.error(
          '[MAMA] Try manually: cd node_modules/better-sqlite3 && npx prebuild-install'
        );
      }
    }
  }

  console.log('[MAMA] Postinstall complete.');
}

main().catch((err) => {
  console.error('[MAMA] Postinstall error:', err.message);
  // Don't fail installation
  process.exit(0);
});
