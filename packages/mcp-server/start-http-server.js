#!/usr/bin/env node
/**
 * Standalone HTTP server launcher for MAMA
 * Starts the embedding HTTP server with Graph Viewer and Mobile Chat
 */

const { startEmbeddingServer } = require('@jungjaehoon/mama-core/embedding-server');

async function main() {
  try {
    const port =
      parseInt(process.env.MAMA_EMBEDDING_PORT || process.env.MAMA_HTTP_PORT || '', 10) || 3849;
    console.log('[MAMA HTTP] Starting server...');
    const server = await startEmbeddingServer(port);

    if (server) {
      console.log('[MAMA HTTP] Server started successfully');
      console.log(`[MAMA HTTP] Access viewer at: http://localhost:${port}/viewer`);
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
