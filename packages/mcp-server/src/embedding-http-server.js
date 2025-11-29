/**
 * MAMA Embedding HTTP Server
 *
 * HTTP API for embedding generation, integrated with MCP server.
 * Provides fast embedding access for Claude Code hooks.
 *
 * Features:
 * - Model stays loaded in memory (singleton)
 * - HTTP API at localhost:3847
 * - Health check endpoint
 * - Shared model with MCP server
 *
 * @module embedding-http-server
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// Import embedding functions from mama module
const { generateEmbedding } = require('./mama/embeddings.js');
const { getModelName, getEmbeddingDim } = require('./mama/config-loader.js');
const { initDB } = require('./mama/memory-store.js');

// Import Graph API handler
const { createGraphHandler } = require('./viewer/graph-api.js');

// Import Session API handler (Mobile Chat)
const { createSessionHandler } = require('./mobile/session-api.js');

// Import WebSocket handler (Mobile Chat)
const { createWebSocketHandler } = require('./mobile/websocket-handler.js');

// Import Session Manager
const { SessionManager } = require('./mobile/session-manager.js');

// Create handler instances
const graphHandler = createGraphHandler();

// Create session manager (shared between REST API and WebSocket)
const sessionManager = new SessionManager();
const sessionHandler = createSessionHandler(sessionManager);

// Configuration
const DEFAULT_PORT = parseInt(process.env.MAMA_HTTP_PORT, 10) || 3847;
const HOST = '127.0.0.1'; // localhost only for security

// Port file for clients to discover the server
const PORT_FILE = path.join(process.env.HOME || '/tmp', '.mama-embedding-port');

// Track if model is loaded
let modelLoaded = false;

/**
 * Read request body as JSON
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * HTTP request handler
 */
async function handleRequest(req, res) {
  // CORS headers for local requests
  // Security Note: CORS '*' is safe here because:
  // 1. Server binds to localhost only (127.0.0.1)
  // 2. No sensitive data exposed (user's own decisions)
  // 3. Required for browser-based Graph Viewer
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: 'ok',
        modelLoaded,
        model: getModelName(),
        dim: getEmbeddingDim(),
      })
    );
    return;
  }

  // Embedding endpoint
  if (req.url === '/embed' && req.method === 'POST') {
    try {
      const startTime = Date.now();
      const body = await readBody(req);

      if (!body.text || typeof body.text !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing or invalid "text" field' }));
        return;
      }

      const embedding = await generateEmbedding(body.text);
      modelLoaded = true;
      const latency = Date.now() - startTime;

      res.writeHead(200);
      res.end(
        JSON.stringify({
          embedding: Array.from(embedding),
          dim: embedding.length,
          latency,
        })
      );
    } catch (error) {
      console.error(`[EmbeddingHTTP] Error: ${error.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Batch embedding endpoint
  if (req.url === '/embed/batch' && req.method === 'POST') {
    try {
      const startTime = Date.now();
      const body = await readBody(req);

      if (!Array.isArray(body.texts)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing or invalid "texts" array' }));
        return;
      }

      const embeddings = await Promise.all(
        body.texts.map((text) => generateEmbedding(text).then((e) => Array.from(e)))
      );
      modelLoaded = true;
      const latency = Date.now() - startTime;

      res.writeHead(200);
      res.end(
        JSON.stringify({
          embeddings,
          count: embeddings.length,
          latency,
        })
      );
    } catch (error) {
      console.error(`[EmbeddingHTTP] Batch error: ${error.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Session API routes (Mobile Chat)
  try {
    const sessionHandled = await sessionHandler(req, res);
    if (sessionHandled) {
      return;
    }
  } catch (error) {
    console.error(`[EmbeddingHTTP] Session API error: ${error.message}`);
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
    return;
  }

  // Graph API routes
  try {
    const handled = await graphHandler(req, res);
    if (handled) {
      return;
    }
  } catch (error) {
    console.error(`[EmbeddingHTTP] Graph API error: ${error.message}`);
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
    return;
  }

  // 404 for unknown routes
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * Write port file for client discovery
 */
function writePortFile(port) {
  try {
    fs.writeFileSync(PORT_FILE, String(port));
    console.error(`[EmbeddingHTTP] Port file written: ${PORT_FILE}`);
  } catch (e) {
    console.error(`[EmbeddingHTTP] Failed to write port file: ${e.message}`);
  }
}

/**
 * Clean up port file on exit
 */
function cleanupPortFile() {
  try {
    if (fs.existsSync(PORT_FILE)) {
      fs.unlinkSync(PORT_FILE);
    }
  } catch (e) {
    // Ignore cleanup errors
  }
}

// Track WebSocket server instance
let _wssInstance = null;

/**
 * Start the HTTP embedding server
 *
 * @param {number} port - Port to listen on (default: 3847)
 * @returns {Promise<http.Server>} HTTP server instance
 */
async function startEmbeddingServer(port = DEFAULT_PORT) {
  // Check if HTTP server is disabled
  if (process.env.MAMA_DISABLE_HTTP_SERVER === 'true') {
    console.error('[EmbeddingHTTP] HTTP server disabled via MAMA_DISABLE_HTTP_SERVER');
    console.error('[EmbeddingHTTP] Graph Viewer and Mobile Chat will not be available');
    return null;
  }

  // Initialize database for graph API
  await initDB();

  // Initialize session manager
  await sessionManager.initDB();

  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(
          `[EmbeddingHTTP] Port ${port} already in use, assuming another instance is running`
        );
        // Not a fatal error - another server instance may be running
        resolve(null);
      } else if (error.code === 'EPERM' || error.code === 'EACCES') {
        console.error(
          `[EmbeddingHTTP] Permission denied opening port ${port}, skipping HTTP embedding server (sandboxed environment)`
        );
        // Some environments block listening on localhost; keep MCP server running without HTTP embeddings
        resolve(null);
      } else {
        reject(error);
      }
    });

    server.listen(port, HOST, () => {
      console.error(`[EmbeddingHTTP] Running at http://${HOST}:${port}`);
      writePortFile(port);

      // Initialize WebSocket server (unless disabled)
      const wsDisabled =
        process.env.MAMA_DISABLE_WEBSOCKET === 'true' ||
        process.env.MAMA_DISABLE_MOBILE_CHAT === 'true';

      if (wsDisabled) {
        console.error('[EmbeddingHTTP] WebSocket/Mobile Chat disabled via environment variable');
        console.error(
          '[EmbeddingHTTP] Set MAMA_DISABLE_WEBSOCKET or MAMA_DISABLE_MOBILE_CHAT to enable'
        );
      } else {
        try {
          _wssInstance = createWebSocketHandler(server, sessionManager);
          console.error(`[EmbeddingHTTP] WebSocket server initialized at ws://${HOST}:${port}/ws`);
        } catch (wsError) {
          console.error(`[EmbeddingHTTP] WebSocket initialization failed: ${wsError.message}`);
          // Continue without WebSocket - HTTP endpoints still work
        }
      }

      resolve(server);
    });
  });
}

/**
 * Pre-warm the embedding model
 */
async function warmModel() {
  console.error('[EmbeddingHTTP] Pre-warming embedding model...');
  const startTime = Date.now();

  try {
    await generateEmbedding('MAMA warmup initialization');
    modelLoaded = true;
    const latency = Date.now() - startTime;
    console.error(`[EmbeddingHTTP] Model warmed in ${latency}ms`);
    return { success: true, latency };
  } catch (error) {
    console.error(`[EmbeddingHTTP] Model warmup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Cleanup on exit
process.on('exit', cleanupPortFile);
process.on('SIGTERM', cleanupPortFile);
process.on('SIGINT', cleanupPortFile);

module.exports = {
  startEmbeddingServer,
  warmModel,
  cleanupPortFile,
  PORT_FILE,
  DEFAULT_PORT,
  HOST,
};
