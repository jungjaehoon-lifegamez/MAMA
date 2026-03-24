/**
 * Telegram Gateway for MAMA Standalone
 *
 * Production-hardened Telegram bot integration:
 * - 2-stage message dedup (message_id + content signature)
 * - Group chat filtering (mention/command/reply-to-bot only)
 * - Sticker receive/send with emotion mapping
 * - ToolStatusTracker streaming (placeholder → editMessageText)
 * - Typing indicator, polling error handling, IPv4 forced
 */

import type { NormalizedMessage } from './types.js';
import { BaseGateway } from './base-gateway.js';
import type { MessageRouter, ProcessingResult } from './message-router.js';
import { getMemoryLogger } from '../memory/memory-logger.js';
import { ToolStatusTracker } from './tool-status-tracker.js';
import type { PlatformAdapter } from './tool-status-tracker.js';

const TELEGRAM_MAX_LENGTH = 4096;
const MESSAGE_DEDUP_TTL_MS = 60_000;
const MESSAGE_CONTENT_DEDUP_TTL_MS = 5_000;
const TYPING_INTERVAL_MS = 4_000;

const EMOTION_EMOJI: Record<string, string[]> = {
  happy: ['😊', '😀', '😄', '🙂'],
  laugh: ['😂', '🤣', '😆'],
  love: ['❤️', '😍', '🥰', '💕'],
  sad: ['😢', '😞', '😔'],
  cry: ['😭', '😿'],
  angry: ['😠', '😡', '🤬'],
  surprised: ['😮', '😲', '😯', '🤯'],
  ok: ['👌', '👍', '✅'],
  thanks: ['🙏', '🤗'],
  sorry: ['🙇', '😓', '💦'],
  hello: ['👋', '🙋', '✋'],
  bye: ['👋', '🫡'],
  thinking: ['🤔', '💭'],
  excited: ['🎉', '🥳', '✨'],
  tired: ['😫', '😩', '😴'],
};

const DEFAULT_STICKER_SET = 'HotCherry';

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
  /** Polling interval in ms */
  pollIntervalMs?: number;
}

/**
 * Telegram Gateway class
 */
export class TelegramGateway extends BaseGateway {
  readonly source = 'telegram' as const;

  private token: string;
  private config: TelegramGatewayConfig;
  private bot: TelegramBot | null = null;
  private botId = 0;
  private botUsername = '';
  private lastError: string | null = null;
  private lastMessageAt: number | undefined;
  private pollIntervalMs: number;

  // Dedup maps
  private recentMessageIds = new Map<string, number>();
  private recentMessageSignatures = new Map<string, number>();

  // Dedup cleanup timer
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Sticker cache
  private stickerCache = new Map<string, string>();
  private stickerSetLoaded = false;

  protected get mentionPattern(): RegExp | null {
    return null; // Group filtering handled explicitly in handleMessage
  }

  constructor(options: TelegramGatewayOptions) {
    super({ messageRouter: options.messageRouter });
    this.token = options.token;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.config = {
      enabled: true,
      token: options.token,
      allowedChats: options.config?.allowedChats || [],
    };
  }

  async start(): Promise<void> {
    if (this.connected) {
      console.log('Telegram gateway already connected');
      return;
    }

    try {
      const TelegramBotModule = await import('node-telegram-bot-api');
      const TelegramBotClass = TelegramBotModule.default;

      this.bot = new TelegramBotClass(this.token, {
        polling: {
          interval: Math.max(this.pollIntervalMs, 2000),
          params: { timeout: 30 },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request: { family: 4 } as any,
      });

      this.bot.on('message', async (msg: unknown) => {
        try {
          await this.handleMessage(msg as TelegramMessage);
        } catch (error) {
          console.error('[Telegram] Error handling message:', error);
          this.emitEvent({
            type: 'error',
            source: 'telegram',
            timestamp: new Date(),
            data: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      });

      this.bot.on('polling_error', (err: unknown) => {
        const error = err as Error;
        this.lastError = error.message ?? String(err);
        console.error(`[Telegram] polling error: ${this.lastError}`);
      });

      const me = await this.bot.getMe();
      this.botId = me.id;
      this.botUsername = me.username || '';
      console.log(`Telegram bot logged in as @${this.botUsername}`);

      this.connected = true;
      this.lastError = null;

      // Periodic dedup cleanup (prevents stale entries when idle)
      this.dedupCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, ts] of this.recentMessageIds) {
          if (now - ts > MESSAGE_DEDUP_TTL_MS) this.recentMessageIds.delete(key);
        }
        for (const [key, ts] of this.recentMessageSignatures) {
          if (now - ts > MESSAGE_CONTENT_DEDUP_TTL_MS) this.recentMessageSignatures.delete(key);
        }
      }, 60_000);

      this.emitEvent({
        type: 'connected',
        source: 'telegram',
        timestamp: new Date(),
        data: { username: this.botUsername },
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('Telegram connection failed:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
    if (this.bot) {
      try {
        await this.bot.stopPolling();
      } catch {
        /* ignore */
      }
      this.bot = null;
      this.stickerCache.clear();
      this.stickerSetLoaded = false;
    }
    this.connected = false;
    this.emitEvent({
      type: 'disconnected',
      source: 'telegram',
      timestamp: new Date(),
    });
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    if (!msg.from || !msg.chat) return;

    const now = Date.now();

    // Stage 1: message_id dedup (60s TTL)
    const messageKey = `${msg.chat.id}:${msg.message_id}`;
    if (this.recentMessageIds.has(messageKey)) return;
    this.recentMessageIds.set(messageKey, now);

    // Stage 2: content signature dedup (5s TTL)
    const rawText = msg.text || msg.sticker?.emoji || '';
    const signature = `${msg.chat.id}:${msg.from.id}:${rawText.trim()}`;
    if (rawText.trim()) {
      const seenAt = this.recentMessageSignatures.get(signature);
      if (seenAt && now - seenAt < MESSAGE_CONTENT_DEDUP_TTL_MS) return;
      this.recentMessageSignatures.set(signature, now);
    }

    // Cleanup expired entries
    for (const [key, ts] of this.recentMessageIds) {
      if (now - ts > MESSAGE_DEDUP_TTL_MS) this.recentMessageIds.delete(key);
    }
    for (const [key, ts] of this.recentMessageSignatures) {
      if (now - ts > MESSAGE_CONTENT_DEDUP_TTL_MS) this.recentMessageSignatures.delete(key);
    }

    // Allowed chats filter
    if (this.config.allowedChats && this.config.allowedChats.length > 0) {
      if (!this.config.allowedChats.includes(String(msg.chat.id))) return;
    }

    // Group chat filtering
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup) {
      const text = msg.text || '';
      const isMention =
        this.botUsername &&
        msg.entities?.some(
          (e) =>
            e.type === 'mention' &&
            text.slice(e.offset, e.offset + e.length).toLowerCase() ===
              `@${this.botUsername.toLowerCase()}`
        );
      const isBotCommand = msg.entities?.some((e) => e.type === 'bot_command');
      const isReplyToBot = msg.reply_to_message?.from?.id === this.botId;
      if (!isMention && !isBotCommand && !isReplyToBot) return;
    }

    // Process text (sticker conversion, mention stripping)
    let text = msg.text || '';
    if (msg.sticker) {
      text = `[sticker: ${msg.sticker.emoji || '😊'}]`;
    }
    if (!text.trim()) return;

    if (isGroup && this.botUsername) {
      const escaped = this.botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`@${escaped}\\b`, 'gi'), '').trim();
    }

    const sender = msg.from.username || String(msg.from.id);
    console.log(`[Telegram] Message from ${sender}: ${text.substring(0, 50)}...`);

    const memoryLogger = getMemoryLogger();
    memoryLogger.logMessage('Telegram', sender, text, false);

    this.emitEvent({
      type: 'message_received',
      source: 'telegram',
      timestamp: new Date(),
      data: { chatId: String(msg.chat.id), userId: String(msg.from.id) },
    });

    const normalizedMessage: NormalizedMessage = {
      source: 'telegram',
      channelId: String(msg.chat.id),
      userId: String(msg.from.id),
      text,
      metadata: {
        username: msg.from.username,
        messageId: String(msg.message_id),
        chatType: msg.chat.type,
      },
    };

    // Typing indicator
    const chatId = String(msg.chat.id);
    const sendTyping = () => this.bot?.sendChatAction(chatId, 'typing').catch(() => {});
    sendTyping();
    const typingInterval = setInterval(sendTyping, TYPING_INTERVAL_MS);

    // ToolStatusTracker for streaming progress
    const bot = this.bot!;
    const telegramAdapter: PlatformAdapter = {
      postPlaceholder: async (content: string) => {
        try {
          const sent = (await bot.sendMessage(chatId, content)) as { message_id: number };
          return String(sent.message_id);
        } catch {
          return null;
        }
      },
      editPlaceholder: async (handle: string, content: string) => {
        try {
          await bot.editMessageText(content, {
            chat_id: chatId,
            message_id: Number(handle),
          });
        } catch {
          /* ignore same-text errors */
        }
      },
      deletePlaceholder: async (handle: string) => {
        try {
          await bot.editMessageText('✅', {
            chat_id: chatId,
            message_id: Number(handle),
          });
        } catch {
          /* ignore */
        }
      },
    };
    const tracker = new ToolStatusTracker(telegramAdapter, {
      throttleMs: 2000,
      initialDelayMs: 1000,
    });
    const streamCallbacks = tracker.toStreamCallbacks();

    // Process through message router
    let result: ProcessingResult;
    try {
      result = await this.messageRouter.process(normalizedMessage, {
        onStream: streamCallbacks,
      });
    } finally {
      clearInterval(typingInterval);
      await tracker.cleanup();
    }

    this.lastMessageAt = Date.now();

    memoryLogger.logMessage('Telegram', 'MAMA', result.response, true);

    await this.sendMessage(chatId, result.response);

    this.emitEvent({
      type: 'message_sent',
      source: 'telegram',
      timestamp: new Date(),
      data: {
        chatId,
        responseLength: result.response.length,
        duration: result.duration,
      },
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    if (!text.trim()) return;
    const chunks = this.splitMessage(text, TELEGRAM_MAX_LENGTH);
    for (const chunk of chunks) {
      try {
        await this.bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      } catch (err) {
        // Retry as plain text only for Markdown parse errors (400)
        const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
        if (status === 400) {
          await this.bot.sendMessage(chatId, chunk);
        } else {
          throw err;
        }
      }
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    await this.bot.sendDocument(chatId, filePath, { caption });
  }

  async sendImage(chatId: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    await this.bot.sendPhoto(chatId, imagePath, { caption });
  }

  async sendSticker(chatId: string | number, emotion: string): Promise<boolean> {
    if (!this.bot) return false;
    await this.loadStickerSet();

    const candidates = EMOTION_EMOJI[emotion] ?? EMOTION_EMOJI.happy;
    for (const emoji of candidates) {
      const fileId = this.stickerCache.get(emoji);
      if (fileId) {
        await this.bot.sendSticker(chatId, fileId);
        return true;
      }
    }
    await this.bot.sendMessage(chatId, candidates[0]);
    return false;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastMessageAt(): number | undefined {
    return this.lastMessageAt;
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      const newline = remaining.lastIndexOf('\n', maxLength);
      const splitAt = newline > maxLength * 0.3 ? newline + 1 : maxLength;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  private async loadStickerSet(): Promise<void> {
    if (this.stickerSetLoaded || !this.bot) return;
    try {
      const set = await this.bot.getStickerSet(DEFAULT_STICKER_SET);
      for (const sticker of set.stickers) {
        if (sticker.emoji && !this.stickerCache.has(sticker.emoji)) {
          this.stickerCache.set(sticker.emoji, sticker.file_id);
        }
      }
      this.stickerSetLoaded = true;
    } catch {
      // Sticker set not found or network error — mark as loaded to prevent repeated failing calls
      this.stickerSetLoaded = true;
    }
  }
}

// Type definitions for node-telegram-bot-api
interface TelegramBot {
  on(event: 'message', callback: (msg: TelegramMessage) => void): void;
  on(event: 'polling_error', callback: (error: Error) => void): void;
  getMe(): Promise<{ id: number; username?: string }>;
  stopPolling(): Promise<void>;
  sendMessage(
    chatId: string | number,
    text: string,
    options?: { parse_mode?: string }
  ): Promise<unknown>;
  editMessageText(
    text: string,
    options: { chat_id: string | number; message_id: number }
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
  sendChatAction(chatId: string | number, action: string): Promise<unknown>;
  sendSticker(chatId: string | number, sticker: string): Promise<unknown>;
  getStickerSet(name: string): Promise<{ stickers: Array<{ file_id: string; emoji?: string }> }>;
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
  sticker?: {
    file_id: string;
    emoji?: string;
    set_name?: string;
  };
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
  reply_to_message?: {
    from?: { id: number };
  };
}
