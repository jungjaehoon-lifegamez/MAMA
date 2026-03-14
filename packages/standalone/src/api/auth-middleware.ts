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
 * Check if request is authenticated.
 *
 * - If MAMA_AUTH_TOKEN or MAMA_SERVER_TOKEN is set: requires valid Authorization header
 *   (localhost bypass DISABLED — Cloudflare Tunnel makes all requests appear local)
 * - If no token is configured: allows localhost requests only
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const adminToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
  if (!adminToken) {
    return isLocalRequest(req);
  }

  // Token is configured — ALWAYS require Bearer token, no localhost bypass
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
 * Express middleware that rejects unauthenticated requests for write operations only.
 * GET/HEAD requests from localhost are allowed without auth.
 * POST/PUT/DELETE always require auth from non-localhost.
 */
export function requireAuthForWrites(req: Request, res: Response, next: NextFunction): void {
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead && isLocalRequest(req)) {
    next();
    return;
  }

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
