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
 * Track if we've warned about missing auth token
 * @type {boolean}
 */
let hasWarnedAboutToken = false;

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
    console.error(
      `[Auth] External access denied from ${req.socket?.remoteAddress} (no MAMA_AUTH_TOKEN)`
    );
    return false;
  }

  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === AUTH_TOKEN) {
      console.error(
        `[Auth] External access granted via Bearer token from ${req.socket?.remoteAddress}`
      );
      return true;
    }
  }

  // Check URL query parameter
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken === AUTH_TOKEN) {
    console.error(
      `[Auth] External access granted via query token from ${req.socket?.remoteAddress}`
    );
    return true;
  }

  console.error(`[Auth] External access denied from ${req.socket?.remoteAddress} (invalid token)`);
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
