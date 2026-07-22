/**
 * Telegram Gateway for MAMA Standalone
 *
 * Production-hardened Telegram bot integration using grammY:
 * - Telegram message_id dedup without dropping repeated short replies
 * - Photo/document/caption ingestion through MAMA content blocks
 * - Group chat filtering (mention/command/reply-to-bot only)
 * - Sticker receive/send with emotion mapping
 * - Single-message streaming presenter (placeholder → final answer)
 * - Typing indicator, error handling
 */

import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Bot } from 'grammy';
import type { Context } from 'grammy';
import type { ContentBlock, MessageAttachment, NormalizedMessage } from './types.js';
import { BaseGateway } from './base-gateway.js';
import type { MessageRouter, ProcessingResult } from './message-router.js';
import { getMemoryLogger } from '../memory/memory-logger.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { buildContentBlocks, detectImageType } from './attachment-utils.js';
import { downloadTelegramMedia, type TelegramMediaDownloadRequest } from './telegram-media.js';
import { TelegramResponsePresenter } from './telegram-response-presenter.js';

const TELEGRAM_MAX_LENGTH = 4096;
const MESSAGE_DEDUP_TTL_MS = 60_000;
const REJECTED_CHAT_WARN_INTERVAL_MS = 60_000;
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
  /** Polling interval in ms (unused with grammY, kept for interface compat) */
  pollIntervalMs?: number;
  /** Internal test seam; production defaults to MAMA's private Telegram media directory. */
  mediaRoot?: string;
  /** Internal test seam for the external Telegram file request. */
  fetchImpl?: TelegramMediaDownloadRequest['fetchImpl'];
}

/**
 * Telegram Gateway class
 */
export class TelegramGateway extends BaseGateway {
  readonly source = 'telegram' as const;

  private token: string;
  private config: TelegramGatewayConfig;
  private bot: Bot | null = null;
  private botId = 0;
  private botUsername = '';
  private lastError: string | null = null;
  private lastMessageAt: number | undefined;
  private readonly mediaRoot: string;
  private readonly fetchImpl?: TelegramMediaDownloadRequest['fetchImpl'];

  // Telegram update dedup
  private recentMessageIds = new Map<string, number>();
  private rejectedChatWarnAt = new Map<string, number>();

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
    this.config = {
      enabled: true,
      token: options.token,
      allowedChats: options.config?.allowedChats || [],
    };
    this.mediaRoot =
      options.mediaRoot ?? join(homedir(), '.mama', 'workspace', 'media', 'inbound', 'telegram');
    this.fetchImpl = options.fetchImpl;
  }

  async start(): Promise<void> {
    if (this.connected) {
      console.log('Telegram gateway already connected');
      return;
    }

    try {
      this.bot = new Bot(this.token);

      this.bot.on('message', async (ctx: Context) => {
        try {
          if (ctx.message) {
            await this.handleMessage(ctx.message);
          }
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

      this.bot.catch((err) => {
        this.lastError = err.message ?? String(err);
        console.error(`[Telegram] error: ${this.lastError}`);
      });

      await this.bot.init();
      this.botId = this.bot.botInfo.id;
      this.botUsername = this.bot.botInfo.username || '';
      console.log(`Telegram bot logged in as @${this.botUsername}`);

      if (this.config.allowedChats && this.config.allowedChats.length > 0) {
        console.log(
          `[Telegram] Inbound allowlist active: ${this.config.allowedChats.length} chat(s)`
        );
      } else {
        console.warn(
          '[Telegram] SECURITY WARNING: telegram.allowed_chats is not set - this bot accepts ' +
            'messages from ANY Telegram user who finds it. Set telegram.allowed_chats in ' +
            '~/.mama/config.yaml to restrict inbound access.'
        );
      }

      this.connected = true;
      this.lastError = null;

      // Periodic dedup cleanup
      this.dedupCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, ts] of this.recentMessageIds) {
          if (now - ts > MESSAGE_DEDUP_TTL_MS) this.recentMessageIds.delete(key);
        }
        for (const [key, ts] of this.rejectedChatWarnAt) {
          if (now - ts > REJECTED_CHAT_WARN_INTERVAL_MS) {
            this.rejectedChatWarnAt.delete(key);
          }
        }
      }, 60_000);

      this.emitEvent({
        type: 'connected',
        source: 'telegram',
        timestamp: new Date(),
        data: { username: this.botUsername },
      });

      // Start long polling (non-blocking)
      this.bot.start();
    } catch (error) {
      if (this.bot) {
        try {
          await this.bot.stop();
        } catch {
          /* ignore */
        }
        this.bot = null;
      }
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
        await this.bot.stop();
      } catch {
        /* ignore */
      }
      this.bot = null;
      this.stickerCache.clear();
      this.stickerSetLoaded = false;
    }
    this.rejectedChatWarnAt.clear();
    this.connected = false;
    this.emitEvent({
      type: 'disconnected',
      source: 'telegram',
      timestamp: new Date(),
    });
  }

  private async handleMessage(msg: NonNullable<Context['message']>): Promise<void> {
    if (!msg.from || !msg.chat) return;

    const now = Date.now();

    // Telegram update dedup (60s TTL). Do not deduplicate by text content:
    // repeated short replies and emoji are distinct conversation turns.
    const messageKey = `${msg.chat.id}:${msg.message_id}`;
    if (this.recentMessageIds.has(messageKey)) return;
    this.recentMessageIds.set(messageKey, now);

    // Cleanup expired entries
    for (const [key, ts] of this.recentMessageIds) {
      if (now - ts > MESSAGE_DEDUP_TTL_MS) this.recentMessageIds.delete(key);
    }

    // Allowed chats filter
    if (this.config.allowedChats && this.config.allowedChats.length > 0) {
      if (!this.config.allowedChats.includes(String(msg.chat.id))) {
        // Rate-cap the warn per chat so a stranger cannot grow daemon.log
        // one line per unique message.
        const lastWarn = this.rejectedChatWarnAt.get(String(msg.chat.id)) ?? 0;
        if (now - lastWarn > REJECTED_CHAT_WARN_INTERVAL_MS) {
          this.rejectedChatWarnAt.set(String(msg.chat.id), now);
          console.warn(
            `[Telegram] Dropped message from non-allowlisted chat ${msg.chat.id} (user ${msg.from?.id ?? 'unknown'})`
          );
        }
        return;
      }
    }

    const hasMedia = Boolean((msg.photo && msg.photo.length > 0) || msg.document);
    if (hasMedia && (!this.config.allowedChats || this.config.allowedChats.length === 0)) {
      const lastWarn = this.rejectedChatWarnAt.get(String(msg.chat.id)) ?? 0;
      if (now - lastWarn > REJECTED_CHAT_WARN_INTERVAL_MS) {
        this.rejectedChatWarnAt.set(String(msg.chat.id), now);
        console.warn('[Telegram] Dropped media because telegram.allowed_chats is not configured');
      }
      return;
    }

    const selectedText = msg.text ?? msg.caption ?? '';
    const selectedEntities = msg.text !== undefined ? msg.entities : msg.caption_entities;

    // Group chat filtering
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup) {
      const isMention =
        this.botUsername &&
        selectedEntities?.some(
          (e) =>
            e.type === 'mention' &&
            selectedText.slice(e.offset, e.offset + e.length).toLowerCase() ===
              `@${this.botUsername.toLowerCase()}`
        );
      const isBotCommand = selectedEntities?.some((e) => e.type === 'bot_command');
      const isReplyToBot = msg.reply_to_message?.from?.id === this.botId;
      if (!isMention && !isBotCommand && !isReplyToBot) return;
    }

    let text = selectedText;
    if (msg.sticker) {
      text = `[sticker: ${msg.sticker.emoji || '😊'}]`;
    }

    if (isGroup && this.botUsername) {
      const escaped = this.botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`@${escaped}\\b`, 'gi'), '').trim();
    }

    // Provenance labeling: a FORWARDED message is third-party content the
    // owner relayed, not the owner speaking. Selection and mention removal
    // happen first so caption provenance follows the same trust boundary.
    const isForwarded = Boolean(msg.forward_origin);

    const numChatId = msg.chat.id;
    const api = this.bot!.api;
    const presenter = new TelegramResponsePresenter({
      send: async (content) => {
        const sent = await api.sendMessage(numChatId, content);
        return String(sent.message_id);
      },
      edit: async (handle, content) => {
        await api.editMessageText(numChatId, Number(handle), content);
      },
      delete: async (handle) => {
        await api.deleteMessage(numChatId, Number(handle));
      },
    });
    await presenter.start();

    const attachments: MessageAttachment[] = [];
    const contentBlocks: ContentBlock[] = [];
    let transientMediaPath: string | undefined;
    try {
      if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        const downloaded = await downloadTelegramMedia({
          botToken: this.token,
          fileId: photo.file_id,
          fileUniqueId: photo.file_unique_id,
          declaredSize: photo.file_size,
          kind: 'photo',
          mediaRoot: this.mediaRoot,
          getFile: (fileId) => api.getFile(fileId),
          fetchImpl: this.fetchImpl,
        });
        transientMediaPath = downloaded.localPath;
        const detectedType = detectImageType(await readFile(downloaded.localPath));
        if (!detectedType) {
          await presenter.fail('This image format is not supported.');
          return;
        }
        const attachment: MessageAttachment = {
          type: 'image',
          sourceRef: downloaded.sourceRef,
          localPath: downloaded.localPath,
          filename: downloaded.filename,
          contentType: detectedType,
          size: downloaded.size,
        };
        attachments.push(attachment);
        const builtBlocks = await buildContentBlocks([attachment]);
        const imageBlocks = builtBlocks.filter((block) => block.type === 'image');
        if (imageBlocks.length === 0) {
          await presenter.fail('This image format is not supported.');
          return;
        }
        for (const block of imageBlocks) {
          contentBlocks.push({ type: 'image', source: block.source });
        }
        delete attachment.localPath;
        if (!text.trim()) {
          text = '[Image]';
        }
      } else if (msg.document) {
        const downloaded = await downloadTelegramMedia({
          botToken: this.token,
          fileId: msg.document.file_id,
          fileUniqueId: msg.document.file_unique_id,
          filename: msg.document.file_name,
          mimeType: msg.document.mime_type,
          declaredSize: msg.document.file_size,
          kind: 'document',
          mediaRoot: this.mediaRoot,
          getFile: (fileId) => api.getFile(fileId),
          fetchImpl: this.fetchImpl,
        });
        transientMediaPath = downloaded.localPath;
        const detectedType = detectImageType(await readFile(downloaded.localPath));
        if (downloaded.mimeType.startsWith('image/') && !detectedType) {
          await presenter.fail('This image format is not supported.');
          return;
        }
        const attachment: MessageAttachment = {
          type: detectedType ? 'image' : 'file',
          sourceRef: downloaded.sourceRef,
          localPath: downloaded.localPath,
          filename: downloaded.filename,
          contentType: detectedType ?? downloaded.mimeType,
          size: downloaded.size,
        };
        attachments.push(attachment);
        if (detectedType) {
          const builtBlocks = await buildContentBlocks([attachment]);
          const imageBlocks = builtBlocks.filter((block) => block.type === 'image');
          if (imageBlocks.length === 0) {
            await presenter.fail('This image format is not supported.');
            return;
          }
          for (const block of imageBlocks) {
            contentBlocks.push({ type: 'image', source: block.source });
          }
          if (!text.trim()) {
            text = `[Image: ${downloaded.filename}]`;
          }
        } else {
          contentBlocks.push({
            type: 'text',
            text: `[File: ${downloaded.filename}, type: ${downloaded.mimeType}]`,
          });
          if (!text.trim()) {
            text = `[File: ${downloaded.filename}]`;
          }
        }
        delete attachment.localPath;
      }
    } catch {
      await presenter.fail(
        msg.document ? 'The file could not be downloaded.' : 'The image could not be downloaded.'
      );
      return;
    } finally {
      if (transientMediaPath) {
        await unlink(transientMediaPath).catch(() => {});
      }
    }

    if (!text.trim()) {
      await presenter.fail('This Telegram message type is not supported.');
      return;
    }

    if (isForwarded) {
      text = wrapUntrustedContent('telegram-forward', text);
    }

    const sender = msg.from.username || String(msg.from.id);
    console.log(`[Telegram] Message from ${sender} (${text.length} chars)`);

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
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      metadata: {
        username: msg.from.username,
        messageId: String(msg.message_id),
        chatType: msg.chat.type,
        attachments: attachments.length > 0 ? attachments : undefined,
        // Trusted provenance flag: downstream strips untrusted blocks ONLY
        // when the GATEWAY wrapped them - sender-typed markers are not a
        // security boundary (forgeable in-band data).
        untrustedWrapped: isForwarded,
      },
    };

    // Typing indicator
    const chatId = String(msg.chat.id);
    const sendTyping = () => this.bot?.api.sendChatAction(numChatId, 'typing').catch(() => {});
    sendTyping();
    const typingInterval = setInterval(sendTyping, TYPING_INTERVAL_MS);

    // Process through message router
    let result: ProcessingResult;
    try {
      result = await this.messageRouter.process(normalizedMessage, {
        onStream: presenter.callbacks(),
      });
      await presenter.finalize(result.response);
    } catch (error) {
      await presenter.fail('An error occurred while processing the message.');
      throw error;
    } finally {
      clearInterval(typingInterval);
    }

    this.lastMessageAt = Date.now();

    memoryLogger.logMessage('Telegram', 'MAMA', result.response, true);

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
    const numChatId = Number(chatId);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(numChatId, chunk);
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const { InputFile } = await import('grammy');
    await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath), { caption });
  }

  async sendImage(chatId: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const { InputFile } = await import('grammy');
    await this.bot.api.sendPhoto(Number(chatId), new InputFile(imagePath), { caption });
  }

  async sendSticker(chatId: string | number, emotion: string): Promise<boolean> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    await this.loadStickerSet();

    const candidates = EMOTION_EMOJI[emotion] ?? EMOTION_EMOJI.happy;
    const numChatId = typeof chatId === 'string' ? Number(chatId) : chatId;
    for (const emoji of candidates) {
      const fileId = this.stickerCache.get(emoji);
      if (fileId) {
        await this.bot.api.sendSticker(numChatId, fileId);
        return true;
      }
    }
    await this.bot.api.sendMessage(numChatId, candidates[0]);
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
      const set = await this.bot.api.getStickerSet(DEFAULT_STICKER_SET);
      for (const sticker of set.stickers) {
        if (sticker.emoji && !this.stickerCache.has(sticker.emoji)) {
          this.stickerCache.set(sticker.emoji, sticker.file_id);
        }
      }
      this.stickerSetLoaded = true;
    } catch {
      this.stickerSetLoaded = true;
    }
  }
}
