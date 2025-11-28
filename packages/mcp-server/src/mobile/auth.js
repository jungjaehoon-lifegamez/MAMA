/**
 * @fileoverview Authentication module - token-based auth for external access
 * @module mobile/auth
 * @version 1.5.0
 *
 * Provides authentication for requests from outside localhost.
 * Uses MAMA_AUTH_TOKEN environment variable for simple token auth.
 *
 * @example
 * const { authenticate, isLocalhost } = require('./auth');
 * if (!authenticate(req)) {
 *   res.writeHead(401);
 *   res.end('Unauthorized');
 * }
 */

/**
 * Environment variable for auth token
 * @type {string|undefined}
 */
const AUTH_TOKEN = process.env.MAMA_AUTH_TOKEN;

/**
 * Check if request is from localhost
 * @param {http.IncomingMessage} req - HTTP request
 * @returns {boolean} True if from localhost
 */
function isLocalhost(req) {
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress;
  return (
    remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  );
}

/**
 * Authenticate an HTTP request
 * @param {http.IncomingMessage} req - HTTP request
 * @returns {boolean} True if authenticated
 */
function authenticate(req) {
  // Localhost always allowed
  if (isLocalhost(req)) {
    return true;
  }

  // External access requires token
  if (!AUTH_TOKEN) {
    console.error('[Auth] MAMA_AUTH_TOKEN not set, denying external access');
    return false;
  }

  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === AUTH_TOKEN) {
      return true;
    }
  }

  // Check URL query parameter
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken === AUTH_TOKEN) {
    return true;
  }

  return false;
}

/**
 * Authenticate a WebSocket upgrade request
 * @param {http.IncomingMessage} req - HTTP upgrade request
 * @param {WebSocket} ws - WebSocket connection
 * @returns {boolean} True if authenticated, closes ws if not
 */
function authenticateWebSocket(req, ws) {
  if (!authenticate(req)) {
    ws.close(4001, 'Authentication required');
    return false;
  }
  return true;
}

/**
 * Create authentication middleware for HTTP routes
 * @returns {Function} Middleware function
 */
function createAuthMiddleware() {
  return (req, res, next) => {
    if (!authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    next();
  };
}

module.exports = {
  authenticate,
  authenticateWebSocket,
  createAuthMiddleware,
  isLocalhost,
  AUTH_TOKEN,
};
