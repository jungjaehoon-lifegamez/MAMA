/**
 * @fileoverview WebSocket Handler - real-time communication for mobile chat
 * @module mobile/websocket-handler
 * @version 1.5.0
 *
 * Handles WebSocket connections for mobile clients, integrating with
 * Claude Code sessions for real-time chat functionality.
 *
 * @example
 * const { createWebSocketHandler } = require('./websocket-handler');
 * const wsHandler = createWebSocketHandler(httpServer, sessionManager);
 */

const { WebSocketServer } = require('ws');
const { authenticateWebSocket } = require('./auth.js');

/**
 * Default heartbeat interval (30 seconds)
 * @type {number}
 */
const HEARTBEAT_INTERVAL = 30000;

/**
 * Connection timeout (35 seconds - slightly longer than heartbeat)
 * @type {number}
 */
const CONNECTION_TIMEOUT = 35000;

/**
 * Generate unique client ID
 * @returns {string}
 */
function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Extract session ID from WebSocket URL
 * @param {string} url - Request URL
 * @returns {string|null}
 */
function extractSessionFromUrl(url) {
  try {
    const params = new URL(url, 'http://localhost').searchParams;
    return params.get('session');
  } catch {
    return null;
  }
}

/**
 * Create WebSocket handler for HTTP server
 * @param {http.Server} httpServer - HTTP server to attach WebSocket to
 * @param {SessionManager} sessionManager - Session manager instance
 * @returns {WebSocketServer}
 */
function createWebSocketHandler(httpServer, sessionManager) {
  // Create WebSocket server without its own HTTP server
  const wss = new WebSocketServer({ noServer: true });

  // Track connected clients
  const clients = new Map();

  // Handle HTTP upgrade requests for WebSocket
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Only handle /ws path
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Create a mock ws object for authentication check
    const mockWs = {
      close: (code, reason) => {
        socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n`);
        socket.destroy();
        console.error(`[WebSocket] Auth failed: ${reason}`);
      },
    };

    // Authenticate the upgrade request
    if (!authenticateWebSocket(req, mockWs)) {
      return;
    }

    // Complete the WebSocket handshake
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // Handle new WebSocket connections
  wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    const sessionId = extractSessionFromUrl(req.url);

    // Store client info
    const clientInfo = {
      clientId,
      sessionId,
      ws,
      isAlive: true,
      connectedAt: new Date().toISOString(),
    };
    clients.set(clientId, clientInfo);

    console.error(
      `[WebSocket] Client ${clientId} connected${sessionId ? ` to session ${sessionId}` : ''}`
    );

    // Assign client to session if specified
    if (sessionId && sessionManager) {
      sessionManager.assignClient(sessionId, clientId);

      // Set up daemon output forwarding
      const session = sessionManager.getSession(sessionId);
      if (session && session.daemon) {
        session.daemon.on('output', (data) => {
          if (ws.readyState === ws.OPEN) {
            // Map daemon's 'text' to viewer's 'content', preserve type as 'output'
            ws.send(
              JSON.stringify({
                type: 'output',
                content: data.text,
                streamType: data.type, // 'stdout' or 'stderr'
                sessionId: data.sessionId,
              })
            );
          }
        });

        // Handle response completion - send stream_end to finalize the message
        session.daemon.on('response_complete', (data) => {
          if (ws.readyState === ws.OPEN) {
            console.error(
              `[WebSocket] Response complete for session ${sessionId}, sending stream_end`
            );
            ws.send(
              JSON.stringify({
                type: 'stream_end',
                sessionId: data.sessionId,
              })
            );
          }
        });

        // Handle daemon exit (backup)
        session.daemon.on('exit', (_data) => {
          if (ws.readyState === ws.OPEN) {
            console.error(`[WebSocket] Daemon exited for session ${sessionId}`);
          }
        });
      }
    }

    // Send welcome message with client ID
    ws.send(
      JSON.stringify({
        type: 'connected',
        clientId,
        sessionId,
      })
    );

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleClientMessage(clientId, message, clientInfo, sessionManager);
      } catch (err) {
        console.error(`[WebSocket] Invalid message from ${clientId}:`, err.message);
        ws.send(
          JSON.stringify({
            type: 'error',
            error: 'Invalid JSON message',
          })
        );
      }
    });

    // Handle pong responses for heartbeat
    ws.on('pong', () => {
      clientInfo.isAlive = true;
    });

    // Handle client disconnect
    ws.on('close', (code, _reason) => {
      console.error(`[WebSocket] Client ${clientId} disconnected (code: ${code})`);

      // Unassign client from session
      if (sessionId && sessionManager) {
        sessionManager.unassignClient(sessionId);
      }

      // Remove from clients map
      clients.delete(clientId);
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error(`[WebSocket] Error for client ${clientId}:`, err.message);
    });
  });

  // Heartbeat interval - ping all clients every 30 seconds
  const heartbeatInterval = setInterval(() => {
    clients.forEach((clientInfo, clientId) => {
      if (!clientInfo.isAlive) {
        console.error(`[WebSocket] Client ${clientId} timed out, terminating`);
        clientInfo.ws.terminate();
        clients.delete(clientId);
        return;
      }

      clientInfo.isAlive = false;
      clientInfo.ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  // Clean up on server close
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  // Add methods to WSS for external access
  wss.getClients = () => clients;
  wss.getClientCount = () => clients.size;

  return wss;
}

/**
 * Handle incoming client message
 * @param {string} clientId - Client identifier
 * @param {Object} message - Parsed message object
 * @param {Object} clientInfo - Client info object
 * @param {SessionManager} sessionManager - Session manager instance
 */
function handleClientMessage(clientId, message, clientInfo, sessionManager) {
  const { type, sessionId, content } = message;

  switch (type) {
    case 'send':
      // Send message to Claude via daemon
      if (clientInfo.sessionId && sessionManager) {
        const session = sessionManager.getSession(clientInfo.sessionId);
        if (session && session.daemon) {
          session.daemon.send(content);
          sessionManager.touchSession(clientInfo.sessionId);
          console.error(`[WebSocket] Message sent to session ${clientInfo.sessionId}`);
        } else {
          clientInfo.ws.send(
            JSON.stringify({
              type: 'error',
              error: 'Session not found or not active',
            })
          );
        }
      } else {
        clientInfo.ws.send(
          JSON.stringify({
            type: 'error',
            error: 'No session assigned',
          })
        );
      }
      break;

    case 'attach':
      // Attach to a different session
      if (sessionId) {
        // Check if session exists
        const session = sessionManager ? sessionManager.getSession(sessionId) : null;

        if (!session || !session.daemon) {
          // Session doesn't exist or has no daemon
          clientInfo.ws.send(
            JSON.stringify({
              type: 'error',
              error: 'session_not_found',
              message: 'Session not found or expired. Please create a new session.',
              sessionId,
            })
          );
          console.error(`[WebSocket] Session ${sessionId} not found for client ${clientId}`);
          break;
        }

        // Unassign from current session
        if (clientInfo.sessionId && sessionManager) {
          sessionManager.unassignClient(clientInfo.sessionId);
        }

        // Assign to new session
        clientInfo.sessionId = sessionId;
        sessionManager.assignClient(sessionId, clientId);

        // Set up daemon output forwarding for this session
        session.daemon.on('output', (data) => {
          if (clientInfo.ws.readyState === clientInfo.ws.OPEN) {
            // Map daemon's 'text' to viewer's 'content', preserve type as 'output'
            clientInfo.ws.send(
              JSON.stringify({
                type: 'output',
                content: data.text,
                streamType: data.type, // 'stdout' or 'stderr'
                sessionId: data.sessionId,
              })
            );
          }
        });

        // Handle response completion for attached session
        session.daemon.on('response_complete', (data) => {
          if (clientInfo.ws.readyState === clientInfo.ws.OPEN) {
            console.error(
              `[WebSocket] Response complete for attached session ${sessionId}, sending stream_end`
            );
            clientInfo.ws.send(
              JSON.stringify({
                type: 'stream_end',
                sessionId: data.sessionId,
              })
            );
          }
        });
        console.error(`[WebSocket] Output forwarding set up for session ${sessionId}`);

        clientInfo.ws.send(
          JSON.stringify({
            type: 'attached',
            sessionId,
          })
        );
        console.error(`[WebSocket] Client ${clientId} attached to session ${sessionId}`);
      }
      break;

    case 'detach':
      // Detach from current session
      if (clientInfo.sessionId && sessionManager) {
        sessionManager.unassignClient(clientInfo.sessionId);
        console.error(
          `[WebSocket] Client ${clientId} detached from session ${clientInfo.sessionId}`
        );
        clientInfo.sessionId = null;

        clientInfo.ws.send(
          JSON.stringify({
            type: 'detached',
          })
        );
      }
      break;

    case 'ping':
      // Client-initiated ping
      clientInfo.ws.send(
        JSON.stringify({
          type: 'pong',
          timestamp: Date.now(),
        })
      );
      break;

    default:
      console.error(`[WebSocket] Unknown message type from ${clientId}: ${type}`);
      clientInfo.ws.send(
        JSON.stringify({
          type: 'error',
          error: `Unknown message type: ${type}`,
        })
      );
  }
}

/**
 * WebSocketHandler class (backwards compatibility)
 * @deprecated Use createWebSocketHandler() instead
 */
class WebSocketHandler {
  constructor(httpServer, sessionManager) {
    this.httpServer = httpServer;
    this.sessionManager = sessionManager;
    this.wss = null;
  }

  init() {
    this.wss = createWebSocketHandler(this.httpServer, this.sessionManager);
    return this.wss;
  }

  getClients() {
    return this.wss ? this.wss.getClients() : new Map();
  }

  getClientCount() {
    return this.wss ? this.wss.getClientCount() : 0;
  }
}

module.exports = {
  createWebSocketHandler,
  WebSocketHandler,
  generateClientId,
  extractSessionFromUrl,
  handleClientMessage,
  HEARTBEAT_INTERVAL,
  CONNECTION_TIMEOUT,
};
