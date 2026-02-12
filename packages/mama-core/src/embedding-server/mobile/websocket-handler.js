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
const { DebugLogger } = require('../../debug-logger.js');

const logger = new DebugLogger('WebSocket');

/**
 * Allowed image MIME types for Claude Vision API
 * @type {Set<string>}
 */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Sanitize filename for safe inclusion in prompts (prevent prompt injection)
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilenameForPrompt(filename) {
  if (!filename) {
    return 'unknown';
  }
  return filename
    .replace(/[\n\r\t]/g, ' ') // Remove control characters
    .replace(/[`[\](){}]/g, '') // Remove brackets that could interfere with prompts
    .substring(0, 100); // Limit length
}

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
        logger.error(`Auth failed: ${reason}`);
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

    logger.info(` Client ${clientId} connected (user: ${userId})`);

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
        logger.info(` Invalid message from ${clientId}:`, err.message);
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
      logger.info(` Client ${clientId} disconnected (code: ${code})`);
      clients.delete(clientId);
    });

    ws.on('error', (err) => {
      logger.info(` Error for client ${clientId}:`, err.message);
    });
  });

  const heartbeatInterval = setInterval(() => {
    clients.forEach((clientInfo, clientId) => {
      if (!clientInfo.isAlive) {
        logger.info(` Client ${clientId} timed out, terminating`);
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
      if (!content && !message.attachments?.length) {
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

        // Keep-alive: Send periodic status updates to prevent WebSocket timeout
        // Browser may disconnect idle WebSocket after ~30 seconds
        let processingSeconds = 0;
        const keepAliveInterval = setInterval(() => {
          processingSeconds += 10;
          if (clientInfo.ws.readyState === 1) {
            // WebSocket.OPEN
            clientInfo.ws.send(
              JSON.stringify({
                type: 'typing',
                status: 'processing',
                elapsed: processingSeconds,
              })
            );
            console.error(
              `[WebSocket] Keep-alive sent to ${clientId} (${processingSeconds}s elapsed)`
            );
          }
        }, 10000); // Every 10 seconds

        // Build contentBlocks from attachments (files are pre-compressed by upload-handler)
        let contentBlocks = undefined;
        if (message.attachments && message.attachments.length > 0) {
          contentBlocks = [];
          for (const att of message.attachments) {
            try {
              // Always reconstruct path from filename — never trust client-provided filePath (LFI risk)
              const safeName = path.basename(att.filename || '');
              const inboundDir = path.join(os.homedir(), '.mama', 'workspace', 'media', 'inbound');
              const resolvedPath = path.join(inboundDir, safeName);
              const data = await fs.readFile(resolvedPath);
              const rawMediaType = att.contentType || 'image/jpeg';

              // Validate MIME type with allowlist
              const mediaType = ALLOWED_IMAGE_TYPES.has(rawMediaType) ? rawMediaType : 'image/jpeg';
              const base64 = data.toString('base64');

              if (ALLOWED_IMAGE_TYPES.has(rawMediaType)) {
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64,
                  },
                });
              } else {
                // PDF/documents: instruct agent to read the file
                // Use safe display path to avoid exposing full server path
                const safeDisplayPath = `~/.mama/workspace/media/inbound/${safeName}`;
                // Sanitize filename to prevent prompt injection
                const sanitizedName = sanitizeFilenameForPrompt(safeName);
                contentBlocks.push({
                  type: 'text',
                  text: `[Document uploaded: ${sanitizedName}]\nFile path: ${safeDisplayPath}\nPlease use the Read tool to analyze this document.`,
                });
              }

              logger.info(`Attached: ${safeName} (${data.length} bytes, ${mediaType})`);
            } catch (err) {
              logger.error(
                `Failed to read attachment ${path.basename(att.filename || '')}:`,
                err.message
              );
              // Notify client about attachment failure
              clientInfo.ws.send(
                JSON.stringify({
                  type: 'attachment_failed',
                  filename: path.basename(att.filename || ''),
                  error: 'Failed to process attachment',
                })
              );
            }
          }
        }

        const normalizedMessage = {
          source: clientInfo.osAgentMode ? 'viewer' : 'mobile',
          channelId: 'mama_os_main', // Fixed channel for all MAMA OS viewers
          channelName: clientInfo.osAgentMode ? 'MAMA OS' : 'Mobile App', // Human-readable channel name
          userId: clientInfo.userId,
          text: content || '',
          contentBlocks,
          metadata: {
            clientId,
            sessionId: clientInfo.sessionId,
            osAgentMode: clientInfo.osAgentMode,
            timestamp: Date.now(),
          },
        };

        let result;
        try {
          result = await messageRouter.process(normalizedMessage);
        } finally {
          clearInterval(keepAliveInterval);
        }

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

        logger.info(` Message processed for ${clientId} (${result.duration}ms)`);
      } catch (error) {
        logger.info(` Message processing error:`, error);
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

      console.error(
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
      console.error(
        `[WebSocket] Checking sessionStore for history: ${!!sessionStore}, hasMethod: ${!!(sessionStore && sessionStore.getHistoryByChannel)}`
      );
      if (sessionStore) {
        try {
          // Use channel-based lookup for sessions
          // Use dynamic source based on osAgentMode (viewer vs mobile)
          const channelId = 'mama_os_main';
          const source = clientInfo.osAgentMode ? 'viewer' : 'mobile';
          logger.info(` Loading history for source=${source}, channelId=${channelId}`);
          const history = sessionStore.getHistoryByChannel
            ? sessionStore.getHistoryByChannel(source, channelId)
            : sessionStore.getHistory(sessionId);
          logger.info(` History loaded: ${history ? history.length : 0} turns`);
          if (history && history.length > 0) {
            // Convert {user, bot, timestamp} format to {role, content, timestamp} for display
            const formattedMessages = history.flatMap((turn) => {
              const messages = [];
              if (turn.user) {
                messages.push({
                  role: 'user',
                  content: turn.user,
                  timestamp: turn.timestamp,
                });
              }
              if (turn.bot) {
                messages.push({
                  role: 'assistant',
                  content: turn.bot,
                  timestamp: turn.timestamp,
                });
              }
              return messages;
            });
            clientInfo.ws.send(
              JSON.stringify({
                type: 'history',
                messages: formattedMessages,
              })
            );
            console.error(
              `[WebSocket] Sent ${formattedMessages.length} history messages to ${clientId}`
            );
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
                ? '✨ I just woke up.\n\nNo name yet, no personality, no memories. Just... pure potential. 🌱\n\nWho are you? And more importantly—who do you want me to become? 💭'
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
              logger.info(` Sent onboarding greeting to ${clientId}`);
            }
          }
        } catch (error) {
          logger.info(` Failed to load history:`, error.message);
        }
      }
      break;
    }

    default:
      logger.info(` Unknown message type from ${clientId}: ${type}`);
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
