/**
 * Shared authentication middleware for MAMA API routes.
 *
 * Extracted from graph-api.ts to allow reuse across all API endpoints.
 * Uses timing-safe comparison and supports localhost bypass when no token is configured.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  recordSecurityEvent,
  recordAuthFailure,
  isIpBanned,
} from '../security/security-monitor.js';
import { getForwardedClientAddress, isTrustedProxyPeer } from '../security/trusted-proxy.js';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    warn: (...args: unknown[]) => void;
  };
};
const authLogger = new DebugLogger('AuthSecurity');

interface AuthOptions {
  allowQueryToken?: boolean;
}

interface SecurityLogContext {
  clientAddress: string;
  remoteAddress: string | null;
  forwardedFor: string | null;
  cfConnectingIp: string | null;
  cfRay: string | null;
  method: string | null;
  path: string | null;
  viaTunnel: boolean;
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

export function hasCloudflareAccessIdentity(req: IncomingMessage): boolean {
  const headers = req.headers;
  return (
    typeof headers['cf-access-jwt-assertion'] === 'string' ||
    typeof headers['cf-access-authenticated-user-email'] === 'string' ||
    typeof headers['cf-access-authenticated-user-uuid'] === 'string'
  );
}

/**
 * Trust Cloudflare Access authenticated requests when:
 * 1. Peer is localhost (request came through local Cloudflare Tunnel), AND
 * 2. Request has CF Access identity headers (user passed Cloudflare Access login)
 *
 * No environment variable needed — if cf-ray + CF Access headers arrive
 * from localhost, it's a Cloudflare Tunnel by definition.
 * MAMA_TRUST_CLOUDFLARE_ACCESS=true is still supported as explicit opt-in
 * but is no longer required.
 */
export function isTrustedCloudflareAccessRequest(req: IncomingMessage): boolean {
  if (!isTrustedProxyPeer(req.socket?.remoteAddress || null)) {
    return false;
  }

  return hasCloudflareAccessIdentity(req);
}

export function getClientAddress(req: IncomingMessage): string {
  return getForwardedClientAddress(req);
}

export function getSecurityLogContext(req: IncomingMessage): SecurityLogContext {
  const rawUrl = req.url || '/';
  let path: string | null = rawUrl;
  try {
    const host = req.headers.host || 'localhost';
    path = new URL(rawUrl, `http://${host}`).pathname;
  } catch {
    // Keep raw URL if parsing fails.
  }

  return {
    clientAddress: getClientAddress(req),
    remoteAddress: req.socket?.remoteAddress || null,
    forwardedFor:
      typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : null,
    cfConnectingIp:
      typeof req.headers['cf-connecting-ip'] === 'string' ? req.headers['cf-connecting-ip'] : null,
    cfRay: typeof req.headers['cf-ray'] === 'string' ? req.headers['cf-ray'] : null,
    method: 'method' in req && typeof req.method === 'string' ? req.method : null,
    path,
    viaTunnel: isTunnelRequest(req),
  };
}

export function logUnauthorizedAttempt(req: IncomingMessage, options: AuthOptions = {}): void {
  let hasQueryToken = false;
  if (options.allowQueryToken && req.url) {
    try {
      hasQueryToken = new URL(
        req.url,
        `http://${req.headers.host || 'localhost'}`
      ).searchParams.has('token');
    } catch {
      hasQueryToken = false;
    }
  }

  const context = getSecurityLogContext(req);
  const details = {
    hasAuthorizationHeader: !!req.headers.authorization,
    hasQueryToken,
    allowQueryToken: !!options.allowQueryToken,
  };
  authLogger.warn('[SECURITY] Unauthorized request blocked', { ...context, ...details });
  recordSecurityEvent({
    type: 'unauthorized_request',
    severity: 'warn',
    message: 'Unauthorized request blocked',
    ...context,
    details,
  });
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
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `http://${host}`);
      return url.searchParams.get('token');
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Check if request is authenticated.
 *
 * - If no token configured: allows direct localhost only
 * - If token configured + real localhost (no tunnel headers): allows without token
 * - If token configured + tunnel/remote: requires Bearer token
 */
export function isAuthenticated(req: IncomingMessage, options: AuthOptions = {}): boolean {
  const adminToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
  if (!adminToken) {
    if (isTrustedCloudflareAccessRequest(req)) {
      return true;
    }
    return isLocalRequest(req) && !isTunnelRequest(req);
  }

  // Real localhost (not via tunnel) — allow without token for local dashboard
  if (isLocalRequest(req) && !isTunnelRequest(req)) {
    return true;
  }

  if (isTrustedCloudflareAccessRequest(req)) {
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
  const clientAddress = getClientAddress(req);

  // Banned IP → reject immediately
  if (isIpBanned(clientAddress)) {
    res.status(403).json({ error: true, code: 'FORBIDDEN', message: 'Access denied.' });
    return;
  }

  if (!isAuthenticated(req)) {
    logUnauthorizedAttempt(req);
    recordAuthFailure(clientAddress);
    res.status(401).json({
      error: true,
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Provide Authorization: Bearer <token> header.',
    });
    return;
  }
  next();
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const clientAddress = getClientAddress(req);
  const adminToken = process.env.MAMA_ADMIN_TOKEN;

  if (isIpBanned(clientAddress)) {
    res.status(403).json({ error: true, code: 'FORBIDDEN', message: 'Access denied.' });
    return;
  }

  if (!adminToken) {
    res.status(503).json({
      error: true,
      code: 'admin_token_required',
      message: 'MAMA_ADMIN_TOKEN is required for admin provenance reads.',
    });
    return;
  }

  const authHeader = req.headers.authorization;
  const token =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || !safeTokenEqual(token, adminToken)) {
    logUnauthorizedAttempt(req);
    recordAuthFailure(clientAddress);
    res.status(401).json({
      error: true,
      code: 'UNAUTHORIZED',
      message: 'Admin authentication required.',
    });
    return;
  }

  next();
}
