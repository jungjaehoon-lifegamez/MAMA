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
import { info, warn } from './debug-logger.js';

// Configuration
export const DEFAULT_PORT =
  parseInt(process.env.MAMA_EMBEDDING_PORT || process.env.MAMA_HTTP_PORT || '', 10) || 3849;
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
  const envPort = parseInt(process.env.MAMA_EMBEDDING_PORT || process.env.MAMA_HTTP_PORT || '', 10);
  if (envPort > 0 && envPort < 65536) {
    return envPort;
  }
  return DEFAULT_PORT;
}

/**
 * Check if embedding server is running
 */
export async function isServerRunning(): Promise<boolean> {
  const port = getServerPort();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);

    const response = await fetch(`http://${HOST}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Generate embedding via HTTP server
 *
 * @param text - Text to embed
 * @returns Embedding or null if failed
 */
export async function getEmbeddingFromServer(text: string): Promise<Float32Array | null> {
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
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error || 'Server error');
    }

    const result = (await response.json()) as { embedding: number[]; latency: number };
    info(`[EmbeddingClient] Got embedding in ${result.latency}ms from server`);
    return new Float32Array(result.embedding);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      warn('[EmbeddingClient] Server timeout, will use fallback');
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    warn(`[EmbeddingClient] Server error: ${message}`);
    return null;
  }
}

/**
 * Get server status
 */
export async function getServerStatus(): Promise<ServerStatus | null> {
  const port = getServerPort();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);

    const response = await fetch(`http://${HOST}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      return (await response.json()) as ServerStatus;
    }
    return null;
  } catch {
    return null;
  }
}
