#!/usr/bin/env node
/**
 * Standalone HTTP server launcher for MAMA
 * Starts the embedding HTTP server with Graph Viewer and Mobile Chat
 */

const { startEmbeddingServer } = require('./src/embedding-http-server.js');

async function main() {
  try {
    console.log('[MAMA HTTP] Starting server...');
    const server = await startEmbeddingServer();

    if (server) {
      console.log('[MAMA HTTP] Server started successfully');
      console.log('[MAMA HTTP] Access viewer at: http://localhost:3847/viewer');
    } else {
      console.log('[MAMA HTTP] Server not started (port in use or permission denied)');
      process.exit(1);
    }
  } catch (error) {
    console.error('[MAMA HTTP] Failed to start:', error);
    process.exit(1);
  }
}

main();
