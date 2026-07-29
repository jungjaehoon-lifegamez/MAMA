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

import fs from 'fs';
import path from 'path';

function resolveConfiguredPort(): number {
  const rawPort = process.env.MAMA_EMBEDDING_PORT || process.env.MAMA_HTTP_PORT || '';
  const parsedPort = parseInt(rawPort, 10);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
    return parsedPort;
  }
  return 3849;
}

// Configuration
export const DEFAULT_PORT = resolveConfiguredPort();
export const HOST = '127.0.0.1';
export const TIMEOUT_MS = 500; // 500ms timeout for fast response
export const PORT_FILE = path.join(process.env.HOME || '/tmp', '.mama-embedding-port');

export interface ServerStatus {
  status: string;
  model?: string;
  dimension?: number;
  uptime?: number;
}

/**
 * Get server port from port file or default
 */
export function getServerPort(): number {
  try {
    if (fs.existsSync(PORT_FILE)) {
      const port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
      if (port > 0 && port < 65536) {
        return port;
      }
    }
  } catch {
    // Ignore errors, use default
  }
  return DEFAULT_PORT;
}
