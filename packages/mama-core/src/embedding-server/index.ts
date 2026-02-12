/**
 * MAMA Embedding HTTP Server
 *
 * HTTP API for embedding generation, integrated with MCP server.
 * Provides fast embedding access for Claude Code hooks.
 *
 * Features:
 * - Model stays loaded in memory (singleton)
 * - HTTP API at localhost:${MAMA_HTTP_PORT || 3849}
 * - Health check endpoint
 * - Shared model with MCP server
 *
 * @module embedding-http-server
 */

import http from 'http';
import type { IncomingMessage, ServerResponse, Server as HTTPServer } from 'http';
import type { Socket } from 'net';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// SECURITY P1: Shutdown token for authenticated takeover
export const SHUTDOWN_TOKEN: string =
  process.env.MAMA_SHUTDOWN_TOKEN || crypto.randomBytes(16).toString('hex');

// Import embedding functions from mama-core
import { generateEmbedding } from '../embeddings.js';
import { getModelName, getEmbeddingDim } from '../config-loader.js';
import { initDB } from '../db-manager.js';

// Import Session API handler (Mobile Chat)
import { createSessionHandler } from './mobile/session-api.js';

// Import WebSocket handler (Mobile Chat - V2 with MessageRouter)
import { createWebSocketHandler } from './mobile/websocket-handler.js';

// Import Session Manager
import { SessionManager } from './mobile/session-manager.js';

// Create session manager (shared between REST API and WebSocket)
const sessionManager = new SessionManager();
const sessionHandler = createSessionHandler(sessionManager);

// Configuration
export const DEFAULT_PORT: number = parseInt(process.env.MAMA_HTTP_PORT || '', 10) || 3849;
export const HOST = '127.0.0.1'; // localhost only for security

// Port file for clients to discover the server
export const PORT_FILE: string = path.join(process.env.HOME || '/tmp', '.mama-embedding-port');

// Track if model is loaded
let modelLoaded = false;

// Track server instance for shutdown
let _serverInstance: HTTPServer | null = null;
let _hasChatCapability = false;

// Track active connections for graceful shutdown
const connections = new Set<Socket>();

// Graph handler (optional, passed from standalone)
let graphHandler: RequestHandler | null = null;

// WebSocket server type
import type { WebSocketServer } from 'ws';

// Track WebSocket server instance (with custom getClients/getClientCount methods)
type ExtendedWss = WebSocketServer & {
  getClients: () => Map<string, unknown>;
  getClientCount: () => number;
};
let _wssInstance: ExtendedWss | null = null;

/**
 * Request handler type
 */
type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * MessageRouter interface
 */
interface MessageRouter {
  process(message: unknown): Promise<unknown>;
}

/**
 * SessionStore interface
 */
interface SessionStore {
  getHistory?(sessionId: string): unknown[];
  getHistoryByChannel?(source: string, channelId: string): unknown[];
}

/**
 * Server options
 */
export interface ServerOptions {
  messageRouter?: MessageRouter;
  sessionStore?: SessionStore;
  graphHandler?: RequestHandler;
}

/**
 * Embed request body
 */
interface EmbedRequestBody {
  text?: string;
  texts?: string[];
}

/**
 * Read request body as JSON
 */
function readBody(req: IncomingMessage): Promise<EmbedRequestBody> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data) as EmbedRequestBody);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * HTTP request handler
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        chatEnabled: _hasChatCapability,
      })
    );
    return;
  }

  // SECURITY P1: Shutdown endpoint with token authentication (for Standalone takeover)
  if (req.url === '/shutdown' && req.method === 'POST') {
    const providedToken = req.headers['x-shutdown-token'];
    if (providedToken !== SHUTDOWN_TOKEN) {
      console.error('[EmbeddingHTTP] SECURITY: Invalid shutdown token rejected');
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Invalid shutdown token' }));
      return;
    }
    console.error('[EmbeddingHTTP] Shutdown requested (Standalone takeover, token validated)');
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'shutting_down' }));
    // Graceful shutdown after response - close WebSocket first, then HTTP
    setTimeout(() => {
      // Close WebSocket server first to release connections
      if (_wssInstance) {
        _wssInstance.clients?.forEach((client) => {
          try {
            client.terminate();
          } catch {
            // Ignore termination errors
          }
        });
        _wssInstance.close(() => {
          console.error('[EmbeddingHTTP] WebSocket server closed');
        });
      }
      // Then close HTTP server
      if (_serverInstance) {
        _serverInstance.close(() => {
          console.error('[EmbeddingHTTP] Server closed for Standalone takeover');
          cleanupPortFile();
        });
        // Force close any remaining connections after a short delay
        setTimeout(() => {
          for (const socket of connections) {
            socket.destroy();
          }
        }, 50);
      }
    }, 100);
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
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[EmbeddingHTTP] Error: ${errMsg}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: errMsg }));
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
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[EmbeddingHTTP] Batch error: ${errMsg}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: errMsg }));
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
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[EmbeddingHTTP] Session API error: ${errMsg}`);
    res.writeHead(500);
    res.end(JSON.stringify({ error: errMsg }));
    return;
  }

  // Graph API routes (Viewer, if graphHandler provided)
  if (graphHandler) {
    try {
      const graphHandled = await graphHandler(req, res);
      if (graphHandled) {
        return;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[EmbeddingHTTP] Graph API error: ${errMsg}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: errMsg }));
      return;
    }
  }

  // Viewer fallback when graphHandler not provided (MCP-only mode)
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const isViewerPath =
    url.pathname === '/' ||
    url.pathname === '/viewer' ||
    url.pathname.startsWith('/viewer/') ||
    url.pathname === '/graph' ||
    url.pathname.startsWith('/graph/');

  if (isViewerPath && !graphHandler) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head><title>MAMA - Standalone Required</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee;">
  <div style="text-align: center; padding: 2rem;">
    <h1>🧠 MAMA Viewer</h1>
    <p>Viewer and Chat features are only available in <strong>Standalone</strong> mode.</p>
    <p style="color: #888; margin-top: 1rem;">Start Standalone: <code style="background: #333; padding: 0.25rem 0.5rem; border-radius: 4px;">mama start</code></p>
    <p style="color: #666; font-size: 0.9rem; margin-top: 2rem;">Current: MCP Server (embedding only)</p>
  </div>
</body>
</html>`);
    return;
  }

  // 404 for unknown routes
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * Write port file for client discovery
 */
function writePortFile(port: number): void {
  try {
    fs.writeFileSync(PORT_FILE, String(port));
    console.error(`[EmbeddingHTTP] Port file written: ${PORT_FILE}`);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`[EmbeddingHTTP] Failed to write port file: ${errMsg}`);
  }
}

/**
 * Clean up port file on exit
 */
export function cleanupPortFile(): void {
  try {
    if (fs.existsSync(PORT_FILE)) {
      fs.unlinkSync(PORT_FILE);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Start the HTTP embedding server
 *
 * @param port - Port to listen on (default: DEFAULT_PORT)
 * @returns HTTP server instance
 */
export async function startEmbeddingServer(
  port: number = DEFAULT_PORT,
  options: ServerOptions = {}
): Promise<HTTPServer | null> {
  const { messageRouter, sessionStore, graphHandler: graphHandlerOption } = options;

  // Track chat capability (Standalone provides messageRouter)
  _hasChatCapability = !!(messageRouter && sessionStore);

  // Store graph handler if provided
  if (graphHandlerOption) {
    graphHandler = graphHandlerOption;
    console.error(`[EmbeddingHTTP] Graph handler registered (Viewer routes on port ${port})`);
  }
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

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(
          `[EmbeddingHTTP] Port ${port} already in use, assuming another instance is running`
        );
        // Not a fatal error - another server instance may be running
        resolve(null);
      } else if (error.code === 'EPERM' || error.code === 'EACCES') {
        console.warn(
          `[EmbeddingHTTP] Permission denied opening port ${port}, skipping HTTP embedding server (sandboxed environment)`
        );
        // Some environments block listening on localhost; keep MCP server running without HTTP embeddings
        resolve(null);
      } else {
        reject(error);
      }
    });

    server.listen(port, HOST, () => {
      console.warn(`[EmbeddingHTTP] Running at http://${HOST}:${port}`);
      // Note: Shutdown token not logged for security (use MAMA_DEBUG=true to enable)
      if (process.env.MAMA_DEBUG === 'true') {
        console.warn(`[EmbeddingHTTP] Shutdown token: ${SHUTDOWN_TOKEN}`);
      }
      writePortFile(port);

      // Track connections for graceful shutdown
      server.on('connection', (socket: Socket) => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
      });

      // Initialize WebSocket server (unless disabled)
      const skipWebSocket =
        process.env.MAMA_DISABLE_WEBSOCKET === 'true' ||
        process.env.MAMA_DISABLE_MOBILE_CHAT === 'true';

      if (!skipWebSocket) {
        try {
          if (messageRouter && sessionStore) {
            _wssInstance = createWebSocketHandler({
              httpServer: server,
              messageRouter: messageRouter as Parameters<typeof createWebSocketHandler>[0]['messageRouter'],
              sessionStore: sessionStore as Parameters<typeof createWebSocketHandler>[0]['sessionStore'],
              authToken: process.env.MAMA_AUTH_TOKEN,
            });
            console.error(
              `[EmbeddingHTTP] WebSocket server initialized (MessageRouter mode) at ws://${HOST}:${port}/ws`
            );
          } else {
            // Legacy mode without MessageRouter - skip for now
            console.error(
              `[EmbeddingHTTP] WebSocket server skipped (no MessageRouter provided)`
            );
          }
        } catch (wsError) {
          const errMsg = wsError instanceof Error ? wsError.message : String(wsError);
          console.error(`[EmbeddingHTTP] WebSocket initialization failed: ${errMsg}`);
        }
      }

      // Track server instance for shutdown
      _serverInstance = server;
      resolve(server);
    });
  });
}

/**
 * Pre-warm the embedding model
 */
export async function warmModel(): Promise<{ success: boolean; latency?: number; error?: string }> {
  console.error('[EmbeddingHTTP] Pre-warming embedding model...');
  const startTime = Date.now();

  try {
    await generateEmbedding('MAMA warmup initialization');
    modelLoaded = true;
    const latency = Date.now() - startTime;
    console.error(`[EmbeddingHTTP] Model warmed in ${latency}ms`);
    return { success: true, latency };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[EmbeddingHTTP] Model warmup failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

// Cleanup on exit
process.on('exit', cleanupPortFile);
process.on('SIGTERM', cleanupPortFile);
process.on('SIGINT', cleanupPortFile);
