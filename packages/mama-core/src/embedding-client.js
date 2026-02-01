/**
 * MAMA Embedding Client
 *
 * HTTP client for the embedding server running in MCP server.
 * Used by hooks for fast embedding generation.
 *
 * Features:
 * - Auto-discovery via port file
 * - Timeout handling
 * - Fallback to local embedding when server unavailable
 *
 * @module embedding-client
 */

const fs = require('fs');
const path = require('path');
const { info, warn } = require('./debug-logger');

// Configuration
const DEFAULT_PORT = 3847;
const HOST = '127.0.0.1';
const TIMEOUT_MS = 500; // 500ms timeout for fast response
const PORT_FILE = path.join(process.env.HOME || '/tmp', '.mama-embedding-port');

/**
 * Get server port from port file or default
 */
function getServerPort() {
  try {
    if (fs.existsSync(PORT_FILE)) {
      const port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
      if (port > 0 && port < 65536) {
        return port;
      }
    }
  } catch (e) {
    // Ignore errors, use default
  }
  return DEFAULT_PORT;
}

/**
 * Check if embedding server is running
 *
 * @returns {Promise<boolean>} True if server is healthy
 */
async function isServerRunning() {
  const port = getServerPort();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);

    const response = await fetch(`http://${HOST}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Generate embedding via HTTP server
 *
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array|null>} Embedding or null if failed
 */
async function getEmbeddingFromServer(text) {
  const port = getServerPort();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(`http://${HOST}:${port}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Server error');
    }

    const result = await response.json();
    info(`[EmbeddingClient] Got embedding in ${result.latency}ms from server`);
    return new Float32Array(result.embedding);
  } catch (error) {
    if (error.name === 'AbortError') {
      warn('[EmbeddingClient] Server timeout, will use fallback');
      return null;
    }
    warn(`[EmbeddingClient] Server error: ${error.message}`);
    return null;
  }
}

/**
 * Get server status
 *
 * @returns {Promise<Object|null>} Server status or null if not running
 */
async function getServerStatus() {
  const port = getServerPort();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);

    const response = await fetch(`http://${HOST}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  isServerRunning,
  getEmbeddingFromServer,
  getServerStatus,
  getServerPort,
  PORT_FILE,
  DEFAULT_PORT,
  HOST,
  TIMEOUT_MS,
};
