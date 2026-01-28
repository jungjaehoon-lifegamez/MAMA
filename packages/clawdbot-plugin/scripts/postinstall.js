#!/usr/bin/env node
/**
 * MAMA Clawdbot Plugin - Postinstall Script
 * Downloads embedding model during installation
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * Main postinstall function for MAMA Clawdbot Plugin.
 * Downloads embedding model and ensures SQLite native module is ready.
 * @returns {Promise<void>}
 */
async function main() {
  console.log('[MAMA] Running postinstall checks...');

  // Check Node.js version
  const nodeVersion = process.versions.node.split('.')[0];
  if (parseInt(nodeVersion) < 18) {
    console.warn('[MAMA] Warning: Node.js 18+ recommended, current:', process.versions.node);
  }

  // Try to download embedding model
  console.log('[MAMA] Pre-downloading embedding model...');

  try {
    // Dynamic import for ESM module
    const { pipeline } = await import('@huggingface/transformers');

    // This will download and cache the model
    console.log('[MAMA] Downloading Xenova/all-MiniLM-L6-v2 (~30MB)...');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });

    // Quick test to verify it works
    const testResult = await extractor('test', { pooling: 'mean', normalize: true });
    console.log('[MAMA] Embedding model ready (dimension:', testResult.data.length, ')');
  } catch (err) {
    // Non-fatal - model will be downloaded on first use
    console.warn('[MAMA] Could not pre-download model:', err.message);
    console.warn('[MAMA] Model will be downloaded on first use.');
  }

  // Check better-sqlite3 via mama-server dependency (not direct dependency)
  // clawdbot-plugin gets sqlite through @jungjaehoon/mama-server
  try {
    // Resolve better-sqlite3 through mama-server's dependency path
    const mamaServerPath = path.dirname(require.resolve('@jungjaehoon/mama-server/package.json'));
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
          console.log('[MAMA] SQLite native module: OK (prebuild installed)');
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
