/**
 * Shared authentication middleware for MAMA API routes.
 *
 * Extracted from graph-api.ts to allow reuse across all API endpoints.
 * Uses timing-safe comparison and supports localhost bypass when no token is configured.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';

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

/**
 * Check if request is authenticated.
 *
 * - If no token configured: allows localhost only
 * - If token configured + real localhost (no tunnel headers): allows without token
 * - If token configured + tunnel/remote: requires Bearer token
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const adminToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
  if (!adminToken) {
    return isLocalRequest(req);
  }

  // Real localhost (not via tunnel) — allow without token for local dashboard
  if (isLocalRequest(req) && !isTunnelRequest(req)) {
    return true;
  }

  // Remote or tunnel request — require Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return false;
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (token.length !== adminToken.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(adminToken));
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

/**
 * Express middleware: localhost requests pass freely, tunnel/remote require auth for ALL methods.
 * - Real localhost GET/POST/PUT/DELETE: allowed (local dashboard)
 * - Tunnel/remote GET/POST/PUT/DELETE: requires Bearer token
 */
export function requireAuthForWrites(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.status(401).json({
      error: true,
      code: 'UNAUTHORIZED',
      message: 'Authentication required for this operation.',
    });
    return;
  }
  next();
}
