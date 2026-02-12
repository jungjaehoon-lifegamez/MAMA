/**
 * @fileoverview Authentication module - token-based auth for external access
 * @module mobile/auth
 * @version 1.5.0
 *
 * Provides authentication for requests from outside localhost.
 * Uses MAMA_AUTH_TOKEN environment variable for simple token auth.
 *
 * @example
 * import { authenticate, isLocalhost } from './auth';
 * if (!authenticate(req)) {
 *   res.writeHead(401);
 *   res.end('Unauthorized');
 * }
 */

import type { IncomingMessage, ServerResponse } from 'http';

// WebSocket type for authentication
interface WebSocketLike {
  close(code?: number, reason?: string): void;
}

/**
 * Environment variable for auth token
 */
export const AUTH_TOKEN: string | undefined = process.env.MAMA_AUTH_TOKEN;

/**
 * Track if we've warned about missing auth token
 */
let hasWarnedAboutToken = false;

/**
 * Check if request is from localhost
 * @param req - HTTP request
 * @returns True if from localhost
 */
export function isLocalhost(req: IncomingMessage): boolean {
  const socket = req.socket as { remoteAddress?: string } | undefined;
  const connection = (req as unknown as { connection?: { remoteAddress?: string } }).connection;
  const remoteAddress = socket?.remoteAddress || connection?.remoteAddress;
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  );
}

/**
 * Authenticate an HTTP request
 * @param req - HTTP request
 * @returns True if authenticated
 */
export function authenticate(req: IncomingMessage): boolean {
  // Localhost always allowed
  if (isLocalhost(req)) {
    return true;
  }

  const remoteAddress = req.socket?.remoteAddress;

  // External access detected - show security warning
  if (!hasWarnedAboutToken) {
    console.error('');
    console.error('⚠️  ========================================');
    console.error('⚠️  SECURITY WARNING: External access detected!');
    console.error('⚠️  ========================================');
    console.error('⚠️  ');
    console.error('⚠️  Your MAMA server is being accessed from outside localhost.');
    console.error('⚠️  This likely means you are using a tunnel (ngrok, Cloudflare, etc.)');
    console.error('⚠️  ');

    if (!AUTH_TOKEN) {
      console.error('⚠️  ❌ CRITICAL: MAMA_AUTH_TOKEN is NOT set!');
      console.error('⚠️  Anyone with your tunnel URL can access your:');
      console.error('⚠️    - Chat sessions with Claude Code');
      console.error('⚠️    - Decision database (~/.claude/mama-memory.db)');
      console.error('⚠️    - Local file system (via Claude Code)');
      console.error('⚠️  ');
      console.error('⚠️  To secure your server, set MAMA_AUTH_TOKEN:');
      console.error('⚠️    export MAMA_AUTH_TOKEN="your-secret-token"');
      console.error('⚠️  ');
    } else {
      console.error('⚠️  ✅ MAMA_AUTH_TOKEN is set (authentication enabled)');
      console.error('⚠️  External clients must provide token in:');
      console.error('⚠️    - Authorization: Bearer <token> header, OR');
      console.error('⚠️    - ?token=<token> query parameter');
      console.error('⚠️  ');
    }

    console.error('⚠️  To disable external access entirely:');
    console.error('⚠️    export MAMA_DISABLE_HTTP_SERVER=true');
    console.error('⚠️    export MAMA_DISABLE_MOBILE_CHAT=true');
    console.error('⚠️  ');
    console.error('⚠️  ========================================');
    console.error('');

    hasWarnedAboutToken = true;
  }

  // External access requires token
  if (!AUTH_TOKEN) {
    console.error(`[Auth] External access denied from ${remoteAddress} (no MAMA_AUTH_TOKEN)`);
    return false;
  }

  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === AUTH_TOKEN) {
      console.error(`[Auth] External access granted via Bearer token from ${remoteAddress}`);
      return true;
    }
  }

  // Check URL query parameter
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken === AUTH_TOKEN) {
    console.error(`[Auth] External access granted via query token from ${remoteAddress}`);
    return true;
  }

  console.error(`[Auth] External access denied from ${remoteAddress} (invalid token)`);
  return false;
}

/**
 * Authenticate a WebSocket upgrade request
 * @param req - HTTP upgrade request
 * @param ws - WebSocket connection
 * @returns True if authenticated, closes ws if not
 */
export function authenticateWebSocket(req: IncomingMessage, ws: WebSocketLike): boolean {
  if (!authenticate(req)) {
    ws.close(4001, 'Authentication required');
    return false;
  }
  return true;
}

/**
 * Middleware function type
 */
type MiddlewareNext = () => void;

/**
 * Create authentication middleware for HTTP routes
 * @returns Middleware function
 */
export function createAuthMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: MiddlewareNext
) => void {
  return (req: IncomingMessage, res: ServerResponse, next: MiddlewareNext) => {
    if (!authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    next();
  };
}
