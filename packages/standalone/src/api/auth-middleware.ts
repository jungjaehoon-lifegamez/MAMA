/**
 * Shared authentication middleware for MAMA API routes.
 *
 * Extracted from graph-api.ts to allow reuse across all API endpoints.
 * Uses timing-safe comparison and supports localhost bypass when no token is configured.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';

interface AuthOptions {
  allowQueryToken?: boolean;
}

/**
 * Check if request originates from localhost
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remoteAddr = req.socket?.remoteAddress;
  return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
}

/**
 * Detect if request is proxied through Cloudflare Tunnel (not truly local).
 * Tunnel adds cf-connecting-ip / cf-ray headers; real localhost requests don't.
 */
function isTunnelRequest(req: IncomingMessage): boolean {
  return !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

function safeTokenEqual(token: string, adminToken: string): boolean {
  if (token.length !== adminToken.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(adminToken));
}

function getRequestToken(req: IncomingMessage, options: AuthOptions = {}): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  }

  if (options.allowQueryToken && req.url) {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url, `http://${host}`);
    return url.searchParams.get('token');
  }

  return null;
}

/**
 * Check if request is authenticated.
 *
 * - If no token configured: allows localhost only
 * - If token configured + real localhost (no tunnel headers): allows without token
 * - If token configured + tunnel/remote: requires Bearer token
 */
export function isAuthenticated(req: IncomingMessage, options: AuthOptions = {}): boolean {
  const adminToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
  if (!adminToken) {
    return isLocalRequest(req);
  }

  // Real localhost (not via tunnel) — allow without token for local dashboard
  if (isLocalRequest(req) && !isTunnelRequest(req)) {
    return true;
  }

  // Remote or tunnel request — require Bearer token
  const token = getRequestToken(req, options);
  if (!token) {
    return false;
  }
  return safeTokenEqual(token, adminToken);
}

/**
 * Express middleware that rejects unauthenticated requests with 401.
 *
 * Usage:
 *   app.post('/api/sensitive', requireAuth, handler);
 *   app.use('/api/cron', requireAuth, cronRouter);
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.status(401).json({
      error: true,
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Provide Authorization: Bearer <token> header.',
    });
    return;
  }
  next();
}
