#!/usr/bin/env node
/**
 * MAMA OpenClaw Plugin - Postinstall Script
 * Warms up embedding stack during installation
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * Main postinstall function for MAMA OpenClaw Plugin.
 * Warms up embedding stack and ensures SQLite native module is ready.
 * @returns {Promise<void>}
 */
async function main() {
  console.log('[MAMA] Running postinstall checks...');

  // Check Node.js version
  const nodeVersion = process.versions.node.split('.')[0];
  if (parseInt(nodeVersion) < 18) {
    console.warn('[MAMA] Warning: Node.js 18+ recommended, current:', process.versions.node);
  }

  // Try to warm up embedding stack via mama-core (single source of truth)
  console.log('[MAMA] Warming up embedding stack via mama-core...');

  try {
    const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
    const vector = await generateEmbedding('MAMA openclaw postinstall warmup');
    console.log('[MAMA] Embedding stack ready (dimension:', vector.length, ')');
  } catch (err) {
    // Non-fatal - embedding stack will initialize on first use
    console.warn('[MAMA] Could not warm embedding stack:', err.message);
    console.warn('[MAMA] Embedding stack will initialize on first use.');
  }

  // Check better-sqlite3 via mama-core dependency (not direct dependency)
  // openclaw-plugin gets sqlite through @jungjaehoon/mama-core
  try {
    // Resolve better-sqlite3 through mama-server's dependency path
    const mamaServerPath = path.dirname(require.resolve('@jungjaehoon/mama-core/package.json'));
    const betterSqlitePath = path.join(mamaServerPath, 'node_modules', 'better-sqlite3');

    // Try loading via mama-server's node_modules
    try {
      require(path.join(betterSqlitePath, 'build/Release/better_sqlite3.node'));
      console.log('[MAMA] SQLite native module: OK');
    } catch (loadErr) {
      // Try prebuild-install in mama-server's better-sqlite3
      if (require('fs').existsSync(betterSqlitePath)) {
        console.warn('[MAMA] SQLite native module not ready, installing prebuild...');
        try {
          execSync('npx prebuild-install', { cwd: betterSqlitePath, stdio: 'inherit' });
          // Re-verify native module actually loads after prebuild-install
          try {
            require(path.join(betterSqlitePath, 'build/Release/better_sqlite3.node'));
            console.log('[MAMA] SQLite native module: OK (prebuild installed)');
          } catch (verifyErr) {
            console.warn(
              '[MAMA] Prebuild installed but module still not loadable:',
              verifyErr.message
            );
            console.warn('[MAMA] SQLite will be loaded at runtime via mama-server');
          }
        } catch (prebuildErr) {
          console.warn('[MAMA] Prebuild install failed:', prebuildErr.message);
          console.warn('[MAMA] SQLite will be loaded at runtime via mama-server');
        }
      } else {
        // Monorepo with hoisted deps - try direct require
        try {
          require('better-sqlite3');
          console.log('[MAMA] SQLite native module: OK (hoisted)');
        } catch {
          console.warn('[MAMA] SQLite native module will be loaded at runtime via mama-server');
        }
      }
    }
  } catch (err) {
    // mama-server not available yet (first install) - skip check
    console.log('[MAMA] SQLite check skipped (dependencies not ready yet)');
  }

  console.log('[MAMA] Postinstall complete.');
}

main().catch((err) => {
  console.error('[MAMA] Postinstall error:', err.message);
  // Don't fail installation
  process.exit(0);
});
