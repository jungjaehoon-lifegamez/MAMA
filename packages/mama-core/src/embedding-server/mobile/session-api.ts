/**
 * @fileoverview Session REST API - HTTP endpoints for session management
 * @module mobile/session-api
 * @version 1.5.0
 *
 * Provides REST API endpoints for creating, listing, and terminating
 * Claude Code sessions.
 *
 * @example
 * import { createSessionHandler } from './session-api';
 * const sessionHandler = createSessionHandler(sessionManager);
 * // Use in HTTP server: if (sessionHandler(req, res)) return;
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { SessionManager } from './session-manager.js';
import { authenticate } from './auth.js';

function resolveConfiguredPort(): number {
  const rawPort = process.env.MAMA_EMBEDDING_PORT || process.env.MAMA_HTTP_PORT || '';
  const parsedPort = parseInt(rawPort, 10);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
    return parsedPort;
  }
  return 3849;
}

/**
 * Default WebSocket port (same as HTTP port)
 */
export const DEFAULT_WS_PORT: number = resolveConfiguredPort();

/**
 * Request body type
 */
interface RequestBody {
  projectDir?: string;
  workDir?: string;
}

/**
 * Parse request body as JSON
 * @param req - HTTP request
 * @returns Parsed JSON body
 */
export function readBody(req: IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => (data += chunk));
    req.on('end', () => {
      try {
        if (!data) {
          resolve({});
        } else {
          resolve(JSON.parse(data) as RequestBody);
        }
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Extract session ID from URL path
 * @param url - Request URL
 * @returns Session ID or null
 */
export function extractSessionId(url: string): string | null {
  const match = url.match(/\/api\/sessions\/([^/?]+)/);
  return match ? match[1] : null;
}

/**
 * Get WebSocket URL for a session
 * @param req - HTTP request
 * @param sessionId - Session ID
 * @returns WebSocket URL
 */
export function getWsUrl(req: IncomingMessage, sessionId: string): string {
  const host = req.headers.host || `localhost:${DEFAULT_WS_PORT}`;
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  return `${protocol}://${host}/ws?session=${sessionId}`;
}

/**
 * Session handler function type
 */
type SessionHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * Create session API request handler
 * @param sessionManager - Session manager instance (will create if not provided)
 * @returns Request handler function
 */
export function createSessionHandler(sessionManager: SessionManager | null = null): SessionHandler {
  // Create session manager if not provided
  const manager = sessionManager || new SessionManager();
  let initialized = false;

  /**
   * Handle session API requests
   * @param req - HTTP request
   * @param res - HTTP response
   * @returns True if request was handled
   */
  return async function handleSessionRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Only handle /api/session routes (includes /api/sessions and /api/session/create)
    if (!pathname.startsWith('/api/session')) {
      return false;
    }

    // Initialize manager on first request
    if (!initialized) {
      try {
        await manager.initDB();
        initialized = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[SessionAPI] Failed to initialize:', message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session manager initialization failed' }));
        return true;
      }
    }

    // Set common headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    // Authentication check
    if (!authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    try {
      // GET /api/sessions - List active sessions
      if (pathname === '/api/sessions' && req.method === 'GET') {
        const sessions = await manager.getActiveSessions();

        res.writeHead(200);
        res.end(
          JSON.stringify({
            sessions: sessions.map((s) => ({
              id: s.id,
              projectDir: s.projectDir,
              status: s.status,
              createdAt: s.createdAt,
              lastActive: s.lastActive,
              isAlive: s.isAlive,
            })),
          })
        );
        return true;
      }

      // POST /api/sessions - Create new session
      // Alias: POST /api/session/create
      if (
        (pathname === '/api/sessions' || pathname === '/api/session/create') &&
        req.method === 'POST'
      ) {
        const body = await readBody(req);

        const projectDir = body.projectDir || body.workDir || '.';

        try {
          const { sessionId } = await manager.createSession(projectDir);
          const wsUrl = getWsUrl(req, sessionId);

          res.writeHead(201);
          res.end(
            JSON.stringify({
              sessionId,
              wsUrl,
              status: 'active',
            })
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[SessionAPI] Failed to create session:', message);
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to create session', details: message }));
        }
        return true;
      }

      // DELETE /api/sessions/:id - Terminate session
      if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
        const sessionId = extractSessionId(pathname);

        if (!sessionId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing session ID' }));
          return true;
        }

        const terminated = await manager.terminateSession(sessionId);

        if (terminated) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, sessionId }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Session not found', sessionId }));
        }
        return true;
      }

      // GET /api/sessions/last-active - Get the most recently active session
      // NOTE: This must come BEFORE the generic :id handler to avoid being matched as an ID
      if (pathname === '/api/sessions/last-active' && req.method === 'GET') {
        const sessions = await manager.getActiveSessions();

        if (sessions.length > 0) {
          // Sort by lastActive descending and get the first one
          const sorted = sessions.sort((a, b) => {
            const aTime = a.lastActive ? new Date(a.lastActive).getTime() : 0;
            const bTime = b.lastActive ? new Date(b.lastActive).getTime() : 0;
            return bTime - aTime;
          });
          const lastSession = sorted[0];

          res.writeHead(200);
          res.end(
            JSON.stringify({
              id: lastSession.id,
              projectDir: lastSession.projectDir,
              status: lastSession.status,
              createdAt: lastSession.createdAt,
              lastActive: lastSession.lastActive,
              isAlive: lastSession.isAlive,
            })
          );
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No active sessions found' }));
        }
        return true;
      }

      // GET /api/sessions/:id - Get single session (bonus endpoint)
      if (pathname.startsWith('/api/sessions/') && req.method === 'GET') {
        const sessionId = extractSessionId(pathname);

        if (!sessionId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing session ID' }));
          return true;
        }

        const session = manager.getSession(sessionId);

        if (session) {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              id: sessionId,
              projectDir: session.projectDir,
              status: 'active',
              createdAt: session.createdAt,
              clientId: session.clientId,
              isAlive: session.daemon?.isActive() || false,
            })
          );
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Session not found', sessionId }));
        }
        return true;
      }

      // Unknown /api/sessions route
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[SessionAPI] Error:', message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error', details: message }));
      return true;
    }
  };
}
