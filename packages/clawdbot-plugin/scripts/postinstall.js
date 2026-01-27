#!/usr/bin/env node
/**
 * MAMA Clawdbot Plugin - Postinstall Script
 * Downloads embedding model during installation
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

  // Check better-sqlite3
  try {
    require('better-sqlite3');
    console.log('[MAMA] SQLite native module: OK');
  } catch (err) {
    console.error('[MAMA] SQLite native module failed:', err.message);
    console.error('[MAMA] You may need build tools: python, make, g++');
  }

  console.log('[MAMA] Postinstall complete.');
}

main().catch((err) => {
  console.error('[MAMA] Postinstall error:', err.message);
  // Don't fail installation
  process.exit(0);
});
