/**
 * Telegram Gateway for MAMA Standalone
 *
 * Provides Telegram bot integration for receiving and responding to messages.
 */

import type { Gateway, GatewayEvent, GatewayEventHandler, NormalizedMessage } from './types.js';
import { MessageRouter } from './message-router.js';
import { getMemoryLogger } from '../memory/memory-logger.js';

/**
 * Telegram Gateway configuration
 */
export interface TelegramGatewayConfig {
  /** Enable Telegram gateway */
  enabled: boolean;
  /** Telegram bot token from @BotFather */
  token: string;
  /** Allowed chat IDs (empty = allow all) */
  allowedChats?: string[];
}

/**
 * Telegram Gateway options
 */
export interface TelegramGatewayOptions {
  /** Telegram bot token */
  token: string;
  /** Message router for processing messages */
  messageRouter: MessageRouter;
  /** Gateway configuration */
  config?: Partial<TelegramGatewayConfig>;
}

/**
 * Telegram Gateway class
 */
export class TelegramGateway implements Gateway {
  readonly source = 'telegram' as const;

  private token: string;
  private messageRouter: MessageRouter;
  private config: TelegramGatewayConfig;
  private eventHandlers: GatewayEventHandler[] = [];
  private connected = false;
  private bot: TelegramBot | null = null;

  constructor(options: TelegramGatewayOptions) {
    this.token = options.token;
    this.messageRouter = options.messageRouter;
    this.config = {
      enabled: true,
      token: options.token,
      allowedChats: options.config?.allowedChats || [],
    };
  }

  /**
   * Start the Telegram gateway
   */
  async start(): Promise<void> {
    if (this.connected) {
      console.log('Telegram gateway already connected');
      return;
    }

    try {
      // Dynamic import to avoid bundling issues if not used
      const TelegramBotModule = await import('node-telegram-bot-api');
      const TelegramBotClass = TelegramBotModule.default;

      this.bot = new TelegramBotClass(this.token, { polling: true });

      // Handle incoming messages
      this.bot.on('message', async (msg) => {
        await this.handleMessage(msg);
      });

      // Get bot info
      const me = await this.bot.getMe();
      console.log(`Telegram bot logged in as @${me.username}`);

      this.connected = true;
      this.emitEvent({
        type: 'connected',
        source: 'telegram',
        timestamp: new Date(),
        data: { username: me.username },
      });
    } catch (error) {
      console.error('Telegram connection failed:', error);
      throw error;
    }
  }

  /**
   * Stop the Telegram gateway
   */
  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
    this.connected = false;
    this.emitEvent({
      type: 'disconnected',
      source: 'telegram',
      timestamp: new Date(),
    });
  }

  /**
   * Handle incoming Telegram message
   */
  private async handleMessage(msg: TelegramMessage): Promise<void> {
    // Check if chat is allowed
    if (this.config.allowedChats && this.config.allowedChats.length > 0) {
      if (!this.config.allowedChats.includes(String(msg.chat.id))) {
        console.log(`[Telegram] Ignoring message from unauthorized chat: ${msg.chat.id}`);
        return;
      }
    }

    const text = msg.text || '';
    if (!text.trim()) return;

    console.log(
      `[Telegram] Message from ${msg.from?.username || msg.from?.id}: ${text.substring(0, 50)}...`
    );

    // Log incoming message
    const memoryLogger = getMemoryLogger();
    memoryLogger.logMessage('Telegram', msg.from?.username || String(msg.from?.id), text, false);

    // Emit message received event
    this.emitEvent({
      type: 'message_received',
      source: 'telegram',
      timestamp: new Date(),
      data: {
        chatId: String(msg.chat.id),
        userId: String(msg.from?.id),
      },
    });

    // Normalize message for router
    const normalizedMessage: NormalizedMessage = {
      source: 'telegram',
      channelId: String(msg.chat.id),
      userId: String(msg.from?.id),
      text,
      metadata: {
        username: msg.from?.username,
        messageId: String(msg.message_id),
        chatType: msg.chat.type,
      },
    };

    // Process through message router
    const result = await this.messageRouter.process(normalizedMessage);

    // Log bot response
    memoryLogger.logMessage('Telegram', 'MAMA', result.response, true);

    // Send response
    await this.sendMessage(String(msg.chat.id), result.response);

    // Emit message sent event
    this.emitEvent({
      type: 'message_sent',
      source: 'telegram',
      timestamp: new Date(),
      data: {
        chatId: String(msg.chat.id),
        responseLength: result.response.length,
        duration: result.duration,
      },
    });
  }

  /**
   * Send message to a chat
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram gateway not connected');
    }

    // Split long messages (Telegram limit: 4096 characters)
    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    }
  }

  /**
   * Send file/document to a chat
   * Supports any file type (documents, images, etc.)
   */
  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram gateway not connected');
    }

    await this.bot.sendDocument(chatId, filePath, { caption });
  }

  /**
   * Send image to a chat
   */
  async sendImage(chatId: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram gateway not connected');
    }

    await this.bot.sendPhoto(chatId, imagePath, { caption });
  }

  /**
   * Split message into chunks
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good split point
      let splitIndex = maxLength;
      const newlineIndex = remaining.lastIndexOf('\n', maxLength);
      if (newlineIndex > maxLength * 0.7) {
        splitIndex = newlineIndex;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trim();
    }

    return chunks;
  }

  /**
   * Emit event to registered handlers
   */
  private emitEvent(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Error in gateway event handler:', error);
      }
    }
  }

  /**
   * Check if gateway is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Register event handler
   */
  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.push(handler);
  }
}

// Type definitions for node-telegram-bot-api
interface TelegramBot {
  on(event: 'message', callback: (msg: TelegramMessage) => void): void;
  getMe(): Promise<{ username?: string }>;
  stopPolling(): Promise<void>;
  sendMessage(
    chatId: string | number,
    text: string,
    options?: { parse_mode?: string }
  ): Promise<unknown>;
  sendPhoto(
    chatId: string | number,
    photo: string,
    options?: { caption?: string }
  ): Promise<unknown>;
  sendDocument(
    chatId: string | number,
    document: string,
    options?: { caption?: string }
  ): Promise<unknown>;
}

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    username?: string;
  };
  chat: {
    id: number;
    type: string;
  };
  text?: string;
}
