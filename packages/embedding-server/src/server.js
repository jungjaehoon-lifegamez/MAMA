#!/usr/bin/env node
/**
 * MAMA Embedding Server
 *
 * Persistent HTTP server for embedding generation.
 * Shared by Claude Code hooks and MCP server.
 *
 * Features:
 * - Model stays loaded in memory (singleton)
 * - HTTP API for embedding requests
 * - Health check endpoint
 * - Graceful shutdown
 *
 * @module embedding-server
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// Configuration
const DEFAULT_PORT = 3847;
const HOST = '127.0.0.1'; // localhost only for security
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

// Singleton for embedding pipeline
let embeddingPipeline = null;
let isLoading = false;
let loadPromise = null;

// Port file for clients to discover the server
const PORT_FILE = path.join(process.env.HOME || '/tmp', '.mama-embedding-port');

/**
 * Load embedding model (singleton)
 */
async function loadModel() {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  if (isLoading && loadPromise) {
    return loadPromise;
  }

  isLoading = true;
  console.log(`[EmbeddingServer] Loading model: ${MODEL_NAME}...`);
  const startTime = Date.now();

  loadPromise = (async () => {
    const transformers = await import('@huggingface/transformers');
    const { pipeline } = transformers;
    embeddingPipeline = await pipeline('feature-extraction', MODEL_NAME);

    const loadTime = Date.now() - startTime;
    console.log(`[EmbeddingServer] Model loaded in ${loadTime}ms (${EMBEDDING_DIM}-dim)`);
    isLoading = false;

    return embeddingPipeline;
  })();

  return loadPromise;
}

/**
 * Generate embedding for text
 */
async function generateEmbedding(text) {
  const model = await loadModel();

  const output = await model(text, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(output.data);
}

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
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: 'ok',
        modelLoaded: !!embeddingPipeline,
        model: MODEL_NAME,
        dim: EMBEDDING_DIM,
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
      const latency = Date.now() - startTime;

      res.writeHead(200);
      res.end(
        JSON.stringify({
          embedding,
          dim: embedding.length,
          latency,
        })
      );
    } catch (error) {
      console.error(`[EmbeddingServer] Error: ${error.message}`);
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

      const embeddings = await Promise.all(body.texts.map((text) => generateEmbedding(text)));
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
      console.error(`[EmbeddingServer] Batch error: ${error.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Shutdown endpoint (for graceful termination)
  if (req.url === '/shutdown' && req.method === 'POST') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'shutting_down' }));
    setTimeout(() => process.exit(0), 100);
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
    console.log(`[EmbeddingServer] Port file written: ${PORT_FILE}`);
  } catch (e) {
    console.error(`[EmbeddingServer] Failed to write port file: ${e.message}`);
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

/**
 * Start the server
 */
async function startServer() {
  const port = parseInt(process.env.MAMA_EMBEDDING_PORT || DEFAULT_PORT, 10);

  // Pre-load model on startup
  console.log('[EmbeddingServer] Pre-loading embedding model...');
  await loadModel();

  const server = http.createServer(handleRequest);

  server.listen(port, HOST, () => {
    console.log(`[EmbeddingServer] Running at http://${HOST}:${port}`);
    writePortFile(port);
  });

  // Graceful shutdown handlers
  process.on('SIGTERM', () => {
    console.log('[EmbeddingServer] Received SIGTERM, shutting down...');
    cleanupPortFile();
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    console.log('[EmbeddingServer] Received SIGINT, shutting down...');
    cleanupPortFile();
    server.close(() => process.exit(0));
  });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error(`[EmbeddingServer] Uncaught exception: ${error.message}`);
    cleanupPortFile();
    process.exit(1);
  });
}

// Start server if run directly
if (require.main === module) {
  startServer().catch((error) => {
    console.error(`[EmbeddingServer] Failed to start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { startServer, generateEmbedding, loadModel };
