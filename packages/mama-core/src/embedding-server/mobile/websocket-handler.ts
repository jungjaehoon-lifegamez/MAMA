/**
 * @fileoverview WebSocket Handler - MessageRouter-based real-time communication
 * @module mobile/websocket-handler
 * @version 2.0.0
 *
 * Handles WebSocket connections for mobile clients, using MessageRouter
 * for unified message processing (same as Discord/Slack gateways).
 *
 * @example
 * import { createWebSocketHandler } from './websocket-handler';
 * const wsHandler = createWebSocketHandler({
 *   httpServer,
 *   messageRouter,
 *   sessionStore,
 *   authToken: process.env.MAMA_AUTH_TOKEN
 * });
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HTTPServer, IncomingMessage } from 'http';
import type { Socket } from 'net';
import { authenticateWebSocket } from './auth.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { DebugLogger } from '../../debug-logger.js';

const logger = new DebugLogger('WebSocket');

/**
 * Allowed image MIME types for Claude Vision API
 */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Sanitize filename for safe inclusion in prompts (prevent prompt injection)
 */
function sanitizeFilenameForPrompt(filename: string): string {
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
 */
const HEARTBEAT_INTERVAL = 30000;

/**
 * Connection timeout (35 seconds - slightly longer than heartbeat)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _CONNECTION_TIMEOUT = 35000;

/**
 * Generate unique client ID
 */
function generateClientId(): string {
  return `client_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Extract user ID from WebSocket URL or headers
 */
function extractUserId(req: IncomingMessage): string {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const userId = url.searchParams.get('userId');
    if (userId) {
      return userId;
    }

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    if (!ip) {
      return `user_${Date.now()}`;
    }
    const ipStr = Array.isArray(ip) ? ip[0] : ip;
    return `user_${ipStr.replace(/[:.]/g, '_')}`;
  } catch {
    return `user_${Date.now()}`;
  }
}

/**
 * Message router interface
 */
interface MessageRouter {
  process(message: NormalizedMessage): Promise<RouterResult>;
}

/**
 * Session store interface
 */
interface SessionStore {
  getHistoryByChannel?(
    source: string,
    channelId: string
  ): Array<{ user?: string; bot?: string; timestamp?: number }>;
  getHistory?(sessionId: string): Array<{ user?: string; bot?: string; timestamp?: number }>;
}

/**
 * Normalized message for router
 */
interface NormalizedMessage {
  source: string;
  channelId: string;
  channelName: string;
  userId: string;
  text: string;
  contentBlocks?: ContentBlock[];
  metadata: {
    clientId: string;
    sessionId?: string;
    osAgentMode?: boolean;
    timestamp: number;
  };
}

/**
 * Content block types
 */
interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface TextContentBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ImageContentBlock | TextContentBlock;

/**
 * Router result
 */
interface RouterResult {
  response: string;
  sessionId: string;
  duration: number;
}

/**
 * Client info stored in clients Map
 */
interface ClientInfo {
  clientId: string;
  userId: string;
  ws: WebSocket;
  isAlive: boolean;
  connectedAt: string;
  sessionId?: string;
  osAgentMode?: boolean;
  language?: string;
}

/**
 * Attachment from client message
 */
interface Attachment {
  filename?: string;
  contentType?: string;
}

/**
 * Client message structure
 */
interface ClientMessage {
  type: string;
  content?: string;
  attachments?: Attachment[];
  sessionId?: string;
  osAgentMode?: boolean;
  language?: string;
}

/**
 * WebSocket handler options
 */
export interface WebSocketHandlerOptions {
  httpServer: HTTPServer;
  messageRouter: MessageRouter;
  sessionStore: SessionStore;
  authToken?: string;
}

/**
 * Extended WebSocketServer with helper methods
 */
type ExtendedWebSocketServer = WebSocketServer & {
  getClients: () => Map<string, ClientInfo>;
  getClientCount: () => number;
};

/**
 * Create WebSocket handler with MessageRouter integration
 */
export function createWebSocketHandler({
  httpServer,
  messageRouter,
  sessionStore,
  authToken: _authToken,
}: WebSocketHandlerOptions): ExtendedWebSocketServer {
  const wss = new WebSocketServer({ noServer: true }) as ExtendedWebSocketServer;
  const clients = new Map<string, ClientInfo>();

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const mockWs = {
      close: (_code: number, reason: string) => {
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

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = generateClientId();
    const userId = extractUserId(req);

    const clientInfo: ClientInfo = {
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

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        void handleClientMessage(clientId, message, clientInfo, messageRouter, sessionStore);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.info(` Invalid message from ${clientId}:`, errMsg);
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

    ws.on('close', (code: number) => {
      logger.info(` Client ${clientId} disconnected (code: ${code})`);
      clients.delete(clientId);
    });

    ws.on('error', (err: Error) => {
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
 */
async function handleClientMessage(
  clientId: string,
  message: ClientMessage,
  clientInfo: ClientInfo,
  messageRouter: MessageRouter,
  sessionStore: SessionStore
): Promise<void> {
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
          if (clientInfo.ws.readyState === WebSocket.OPEN) {
            clientInfo.ws.send(
              JSON.stringify({
                type: 'typing',
                status: 'processing',
                elapsed: processingSeconds,
              })
            );
            logger.debug(`Keep-alive sent to ${clientId} (${processingSeconds}s elapsed)`);
          }
        }, 10000); // Every 10 seconds

        // Build contentBlocks from attachments (files are pre-compressed by upload-handler)
        let contentBlocks: ContentBlock[] | undefined = undefined;
        if (message.attachments && message.attachments.length > 0) {
          contentBlocks = [];
          for (const att of message.attachments) {
            try {
              // Always reconstruct path from filename — never trust client-provided filePath (LFI risk)
              const safeName = path.basename(att.filename || '');
              const inboundDir = path.join(os.homedir(), '.mama', 'workspace', 'media', 'inbound');
              const resolvedPath = path.join(inboundDir, safeName);
              // Default to octet-stream for unknown types — prevents untyped attachments
              // from being incorrectly treated as images and base64-encoded
              const rawMediaType = att.contentType || 'application/octet-stream';

              if (ALLOWED_IMAGE_TYPES.has(rawMediaType)) {
                // Only read file for images (to convert to base64)
                const data = await fs.readFile(resolvedPath);
                const base64 = data.toString('base64');
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: rawMediaType,
                    data: base64,
                  },
                });
                logger.info(`Attached image: ${safeName} (${data.length} bytes, ${rawMediaType})`);
              } else {
                // PDF/documents: instruct agent to read the file (no need to load into memory)
                // Use safe display path to avoid exposing full server path
                const safeDisplayPath = `~/.mama/workspace/media/inbound/${safeName}`;
                // Sanitize filename to prevent prompt injection
                const sanitizedName = sanitizeFilenameForPrompt(safeName);
                contentBlocks.push({
                  type: 'text',
                  text: `[Document uploaded: ${sanitizedName}]\nFile path: ${safeDisplayPath}\nPlease use the Read tool to analyze this document.`,
                });
                logger.info(`Attached document: ${safeName} (${rawMediaType})`);
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.error(
                `Failed to read attachment ${path.basename(att.filename || '')}:`,
                errMsg
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

        const normalizedMessage: NormalizedMessage = {
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

        let result: RouterResult;
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
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.info(` Message processing error:`, error);
        clientInfo.ws.send(
          JSON.stringify({
            type: 'error',
            error: 'Failed to process message',
            details: errMsg,
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

      logger.info(
        `Client ${clientId} attached to session ${sessionId}${osAgentMode ? ' (OS Agent mode)' : ''}`
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
      logger.debug(
        `Checking sessionStore for history: ${!!sessionStore}, hasMethod: ${!!(sessionStore && sessionStore.getHistoryByChannel)}`
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
            : sessionStore.getHistory?.(sessionId || '');
          logger.info(` History loaded: ${history ? history.length : 0} turns`);
          if (history && history.length > 0) {
            // Convert {user, bot, timestamp} format to {role, content, timestamp} for display
            const formattedMessages = history.flatMap((turn) => {
              const messages: Array<{ role: string; content: string; timestamp?: number }> = [];
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
            logger.info(`Sent ${formattedMessages.length} history messages to ${clientId}`);
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
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.info(` Failed to load history:`, errMsg);
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
export class WebSocketHandler {
  private wss: ExtendedWebSocketServer;

  constructor(httpServer: HTTPServer, options: Partial<WebSocketHandlerOptions>) {
    if (!options.messageRouter) {
      throw new Error('WebSocketHandler requires messageRouter option');
    }
    if (!options.sessionStore) {
      throw new Error('WebSocketHandler requires sessionStore option');
    }
    this.wss = createWebSocketHandler({
      httpServer,
      messageRouter: options.messageRouter,
      sessionStore: options.sessionStore,
      authToken: options.authToken,
    });
  }

  getClients(): Map<string, ClientInfo> {
    return this.wss.getClients();
  }

  getClientCount(): number {
    return this.wss.getClientCount();
  }

  close(): void {
    this.wss.close();
  }
}
