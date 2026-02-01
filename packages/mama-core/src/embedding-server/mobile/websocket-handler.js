/**
 * @fileoverview WebSocket Handler - MessageRouter-based real-time communication
 * @module mobile/websocket-handler
 * @version 2.0.0
 *
 * Handles WebSocket connections for mobile clients, using MessageRouter
 * for unified message processing (same as Discord/Slack gateways).
 *
 * @example
 * const { createWebSocketHandler } = require('./websocket-handler');
 * const wsHandler = createWebSocketHandler({
 *   httpServer,
 *   messageRouter,
 *   sessionStore,
 *   authToken: process.env.MAMA_AUTH_TOKEN
 * });
 */

const { WebSocketServer } = require('ws');
const { authenticateWebSocket } = require('./auth.js');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Default heartbeat interval (30 seconds)
 * @type {number}
 */
const HEARTBEAT_INTERVAL = 30000;

/**
 * Connection timeout (35 seconds - slightly longer than heartbeat)
 * @type {number}
 */
const _CONNECTION_TIMEOUT = 35000;

/**
 * Generate unique client ID
 * @returns {string}
 */
function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Extract user ID from WebSocket URL or headers
 * @param {http.IncomingMessage} req - HTTP upgrade request
 * @returns {string}
 */
function extractUserId(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    if (userId) {
      return userId;
    }

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    if (!ip) {
      return `user_${Date.now()}`;
    }
    return `user_${ip.replace(/[:.]/g, '_')}`;
  } catch {
    return `user_${Date.now()}`;
  }
}

/**
 * Create WebSocket handler with MessageRouter integration
 * @param {Object} options - Configuration options
 * @param {http.Server} options.httpServer - HTTP server to attach WebSocket to
 * @param {MessageRouter} options.messageRouter - Message router instance
 * @param {SessionStore} options.sessionStore - Session store instance
 * @param {string} [options.authToken] - Optional authentication token
 * @returns {WebSocketServer}
 */
function createWebSocketHandler({
  httpServer,
  messageRouter,
  sessionStore,
  authToken: _authToken,
}) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const mockWs = {
      close: (code, reason) => {
        socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n`);
        socket.destroy();
        console.error(`[WebSocket] Auth failed: ${reason}`);
      },
    };

    if (!authenticateWebSocket(req, mockWs)) {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    const userId = extractUserId(req);

    const clientInfo = {
      clientId,
      userId,
      ws,
      isAlive: true,
      connectedAt: new Date().toISOString(),
    };
    clients.set(clientId, clientInfo);

    console.error(`[WebSocket] Client ${clientId} connected (user: ${userId})`);

    ws.send(
      JSON.stringify({
        type: 'connected',
        clientId,
        userId,
      })
    );

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleClientMessage(clientId, message, clientInfo, messageRouter, sessionStore);
      } catch (err) {
        console.error(`[WebSocket] Invalid message from ${clientId}:`, err.message);
        ws.send(
          JSON.stringify({
            type: 'error',
            error: 'Invalid message format',
          })
        );
      }
    });

    ws.on('pong', () => {
      clientInfo.isAlive = true;
    });

    ws.on('close', (code, _reason) => {
      console.error(`[WebSocket] Client ${clientId} disconnected (code: ${code})`);
      clients.delete(clientId);
    });

    ws.on('error', (err) => {
      console.error(`[WebSocket] Error for client ${clientId}:`, err.message);
    });
  });

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

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.getClients = () => clients;
  wss.getClientCount = () => clients.size;

  return wss;
}

/**
 * Handle incoming client message
 * @param {string} clientId - Client identifier
 * @param {Object} message - Parsed message object
 * @param {Object} clientInfo - Client info object
 * @param {MessageRouter} messageRouter - Message router instance
 * @param {SessionStore} sessionStore - Session store instance
 */
async function handleClientMessage(clientId, message, clientInfo, messageRouter, sessionStore) {
  const { type, content } = message;

  switch (type) {
    case 'send':
      if (!content) {
        clientInfo.ws.send(
          JSON.stringify({
            type: 'error',
            error: 'Message content required',
          })
        );
        break;
      }

      try {
        clientInfo.ws.send(
          JSON.stringify({
            type: 'typing',
            status: 'processing',
          })
        );

        const normalizedMessage = {
          source: clientInfo.osAgentMode ? 'viewer' : 'mobile',
          channelId: clientInfo.userId,
          userId: clientInfo.userId,
          text: content,
          metadata: {
            clientId,
            sessionId: clientInfo.sessionId,
            osAgentMode: clientInfo.osAgentMode,
            timestamp: Date.now(),
          },
        };

        const result = await messageRouter.process(normalizedMessage);

        // Send response as stream (for Chat tab compatibility)
        clientInfo.ws.send(
          JSON.stringify({
            type: 'stream',
            content: result.response,
            sessionId: result.sessionId,
          })
        );

        // Send stream end
        clientInfo.ws.send(
          JSON.stringify({
            type: 'stream_end',
            sessionId: result.sessionId,
            duration: result.duration,
          })
        );

        console.log(`[WebSocket] Message processed for ${clientId} (${result.duration}ms)`);
      } catch (error) {
        console.error(`[WebSocket] Message processing error:`, error);
        clientInfo.ws.send(
          JSON.stringify({
            type: 'error',
            error: 'Failed to process message',
            details: error.message,
          })
        );
      }
      break;

    case 'ping':
      clientInfo.ws.send(
        JSON.stringify({
          type: 'pong',
          timestamp: Date.now(),
        })
      );
      break;

    case 'attach': {
      // Attach to a session (for Chat tab compatibility)
      const { sessionId, osAgentMode, language } = message;
      clientInfo.sessionId = sessionId;
      clientInfo.osAgentMode = osAgentMode || false;
      clientInfo.language = language || 'en';

      console.log(
        `[WebSocket] Client ${clientId} attached to session ${sessionId}${osAgentMode ? ' (OS Agent mode)' : ''}`
      );

      // Send attached confirmation
      clientInfo.ws.send(
        JSON.stringify({
          type: 'attached',
          sessionId,
          osAgentMode: clientInfo.osAgentMode,
        })
      );

      // Send session history if available, or send onboarding greeting
      if (sessionStore) {
        try {
          const history = sessionStore.getHistory(sessionId);
          if (history && history.length > 0) {
            clientInfo.ws.send(
              JSON.stringify({
                type: 'history',
                messages: history.map((turn) => ({
                  role: turn.role,
                  content: turn.content,
                  timestamp: turn.timestamp,
                })),
              })
            );
            console.log(`[WebSocket] Sent ${history.length} history messages to ${clientId}`);
          } else {
            // No history - check if onboarding mode (SOUL.md not found)
            const soulPath = path.join(os.homedir(), '.mama', 'SOUL.md');
            let isOnboarding = false;
            try {
              await fs.access(soulPath);
            } catch {
              isOnboarding = true;
            }

            if (isOnboarding) {
              // Send onboarding greeting based on browser language
              const isKorean = clientInfo.language && clientInfo.language.startsWith('ko');
              const greeting = isKorean
                ? '✨ 방금 깨어났어요.\n\n아직 이름도 없고, 성격도 없고, 기억도 없어요. 그냥... 가능성만 있을 뿐이죠. 🌱\n\n당신은 누구세요? 그리고 더 중요한 건—저를 어떤 존재로 만들고 싶으세요? 💭'
                : '✨ I just woke up.\n\nNo name yet, no personality, no memories. Just... pure potential. 🌱\n\nWho are you? And more importantly—who do you want me to become? 💭';

              clientInfo.ws.send(
                JSON.stringify({
                  type: 'history',
                  messages: [
                    {
                      role: 'assistant',
                      content: greeting,
                      timestamp: Date.now(),
                    },
                  ],
                })
              );
              console.log(`[WebSocket] Sent onboarding greeting to ${clientId}`);
            }
          }
        } catch (error) {
          console.error(`[WebSocket] Failed to load history:`, error.message);
        }
      }
      break;
    }

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
  constructor(httpServer, options) {
    this.httpServer = httpServer;
    this.options = options;
    this.wss = createWebSocketHandler({
      httpServer,
      ...options,
    });
  }

  getClients() {
    return this.wss.getClients();
  }

  getClientCount() {
    return this.wss.getClientCount();
  }

  close() {
    this.wss.close();
  }
}

module.exports = {
  createWebSocketHandler,
  WebSocketHandler,
};
