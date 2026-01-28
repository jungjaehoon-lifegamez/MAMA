#!/usr/bin/env node
/**
 * MAMA Clawdbot Plugin - Postinstall Script
 * Downloads embedding model during installation
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

  // Check better-sqlite3 and install prebuild if needed (uses shared utility)
  try {
    // Try to use shared utility first
    const sharedScript = path.resolve(__dirname, '../../../scripts/ensure-sqlite-prebuild.js');
    const { ensureSqlitePrebuild } = require(sharedScript);
    ensureSqlitePrebuild({ prefix: '[MAMA]' });
  } catch {
    // Shared utility not available (e.g., when installed from npm), use inline logic
    try {
      require('better-sqlite3');
      console.log('[MAMA] SQLite native module: OK');
    } catch (err) {
      console.warn('[MAMA] SQLite native module not ready, installing prebuild...');

      const betterSqlitePath = path.dirname(require.resolve('better-sqlite3/package.json'));

      try {
        let prebuildCmd = 'npx prebuild-install';
        try {
          const prebuildPath = require.resolve('prebuild-install/bin.js');
          prebuildCmd = `node "${prebuildPath}"`;
        } catch {
          // use npx
        }

        execSync(prebuildCmd, { cwd: betterSqlitePath, stdio: 'inherit' });

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
