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
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { Bot } from 'grammy';
import type { Context } from 'grammy';
import type { ContentBlock, MessageAttachment, NormalizedMessage } from './types.js';
import { BaseGateway } from './base-gateway.js';
import type { MessageRouter, ProcessingResult } from './message-router.js';
import { getMemoryLogger } from '../memory/memory-logger.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { buildContentBlocks, detectImageType } from './attachment-utils.js';
import {
  downloadTelegramMedia,
  pruneTelegramMediaRoot,
  type TelegramMediaDownloadRequest,
} from './telegram-media.js';
import { splitTelegramMessage, TelegramResponsePresenter } from './telegram-response-presenter.js';
import { TelegramMessageLedger } from './telegram-message-ledger.js';

const TELEGRAM_MAX_LENGTH = 4096;
const MESSAGE_DEDUP_TTL_MS = 60_000;
const REJECTED_CHAT_WARN_INTERVAL_MS = 60_000;
const TYPING_INTERVAL_MS = 4_000;

function parseOutboundChunkProgress(value: string): { nextIndex: number; uncertain: boolean } {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid Telegram outbound progress');
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.nextIndex) ||
    (record.nextIndex as number) < 0 ||
    typeof record.uncertain !== 'boolean'
  ) {
    throw new Error('Invalid Telegram outbound progress');
  }
  return { nextIndex: record.nextIndex as number, uncertain: record.uncertain };
}

function isDefiniteTelegramApiRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (Number.isSafeInteger(record.error_code)) return true;
  const response = record.response;
  return (
    Boolean(response) &&
    typeof response === 'object' &&
    Number.isSafeInteger((response as Record<string, unknown>).error_code)
  );
}

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
  /** Internal test/operations seam for restart-safe completed-message deduplication. */
  messageLedgerPath?: string;
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
  private readonly messageLedger: TelegramMessageLedger;
  private readonly chatTails = new Map<string, Promise<void>>();
  private readonly activeChat = new AsyncLocalStorage<string>();

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
      options.mediaRoot ??
      join(
        process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace'),
        'media',
        'inbound',
        'telegram'
      );
    this.fetchImpl = options.fetchImpl;
    this.messageLedger = new TelegramMessageLedger(
      options.messageLedgerPath ??
        process.env.MAMA_TELEGRAM_MESSAGE_LEDGER_PATH ??
        `${this.mediaRoot}.processed-message-ids.json`,
      { log: (line) => console.error(line) }
    );
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
          // Let grammY treat the update as failed. The durable message ledger
          // prevents unsafe turn re-execution and replays a ready outbox response.
          throw error;
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

      await this.recoverPendingInboundDeliveries();

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

      await pruneTelegramMediaRoot(this.mediaRoot);

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
        void pruneTelegramMediaRoot(this.mediaRoot).catch((error: unknown) => {
          console.error(
            `[Telegram] media retention cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
        void this.recoverPendingInboundDeliveries().catch((error: unknown) => {
          console.error(
            `[Telegram] pending response recovery failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
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
    const chatKey = String(msg.chat?.id ?? 'unknown');
    await this.runInChatQueue(chatKey, () => this.processMessage(msg));
  }

  private async runInChatQueue<T>(
    chatKey: string,
    work: () => Promise<T>,
    allowReentrant = false
  ): Promise<T> {
    if (allowReentrant && this.activeChat.getStore() === chatKey) return work();
    const previous = this.chatTails.get(chatKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentTail = (previous ?? Promise.resolve()).catch(() => {}).then(() => gate);
    this.chatTails.set(chatKey, currentTail);

    try {
      if (previous) await previous.catch(() => {});
      return await this.activeChat.run(chatKey, work);
    } finally {
      release();
      if (this.chatTails.get(chatKey) === currentTail) this.chatTails.delete(chatKey);
    }
  }

  private async processMessage(msg: NonNullable<Context['message']>): Promise<void> {
    if (!msg.from || !msg.chat) return;

    const now = Date.now();

    // Telegram update dedup (60s TTL). Do not deduplicate by text content:
    // repeated short replies and emoji are distinct conversation turns.
    const messageKey = `${msg.chat.id}:${msg.message_id}`;
    if (this.messageLedger.get(messageKey)?.state === 'delivered') return;
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

    const durableEntry = this.messageLedger.get(messageKey);
    const numChatId = msg.chat.id;
    const api = this.bot!.api;
    const presenter = this.createResponsePresenter(
      numChatId,
      messageKey,
      durableEntry?.nextChunkIndex ?? 0
    );
    if (durableEntry?.state !== 'ready') await presenter.start();
    if (durableEntry?.state === 'ready' && durableEntry.response !== undefined) {
      try {
        await presenter.finalize(durableEntry.response);
        this.messageLedger.markDelivered(messageKey);
      } catch (error) {
        this.recentMessageIds.delete(messageKey);
        throw error;
      }
      return;
    }
    if (durableEntry?.state === 'processing') {
      const interruptedNotice =
        'The previous processing attempt was interrupted. It was not rerun because its external ' +
        'side effects could not be proven safe to repeat. Please send a new message if you want ' +
        'to retry it.';
      this.messageLedger.markReady(messageKey, interruptedNotice);
      try {
        await presenter.finalize(interruptedNotice);
        this.messageLedger.markDelivered(messageKey);
      } catch (error) {
        this.recentMessageIds.delete(messageKey);
        throw error;
      }
      return;
    }

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
        // Keep the private local path for bounded OCR/overlay follow-ups. The
        // media retention sweeper removes it after the configured TTL/quota.
        transientMediaPath = undefined;
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
          transientMediaPath = undefined;
        } else {
          contentBlocks.push({
            type: 'text',
            text: `[File: ${downloaded.filename}, type: ${downloaded.mimeType}]`,
          });
          if (!text.trim()) {
            text = `[File: ${downloaded.filename}]`;
          }
          // Documents remain in the private inbound workspace so the routed
          // turn and a bounded follow-up can read the actual attachment.
          transientMediaPath = undefined;
        }
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

    try {
      // Process through message router
      let result: ProcessingResult;
      this.messageLedger.claim(messageKey);
      try {
        result = await this.messageRouter.process(normalizedMessage, {
          onStream: presenter.callbacks(),
          onQueued: () => presenter.markQueued(),
        });
      } catch (error) {
        const failureNotice = 'An error occurred while processing the message.';
        this.messageLedger.markReady(messageKey, failureNotice);
        try {
          await presenter.fail(failureNotice);
          this.messageLedger.markDelivered(messageKey);
        } catch {
          this.recentMessageIds.delete(messageKey);
        }
        throw error;
      }

      this.messageLedger.markReady(messageKey, result.response);
      try {
        await presenter.finalize(result.response);
        this.messageLedger.markDelivered(messageKey);
      } catch (error) {
        this.recentMessageIds.delete(messageKey);
        throw error;
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
    } finally {
      clearInterval(typingInterval);
    }
  }

  async sendMessage(chatId: string, text: string, idempotencyKey?: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    if (!text.trim()) return;
    await this.runInChatQueue(chatId, () => this.sendMessageNow(chatId, text, idempotencyKey));
  }

  async sendMessageFromActiveTurn(
    chatId: string,
    text: string,
    idempotencyKey?: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    if (!text.trim()) return;
    await this.runInChatQueue(
      chatId,
      () => this.sendMessageNow(chatId, text, idempotencyKey),
      true
    );
  }

  private async sendMessageNow(
    chatId: string,
    text: string,
    idempotencyKey?: string
  ): Promise<void> {
    const bot = this.bot;
    if (!bot) throw new Error('Telegram gateway not connected');
    const chunks = splitTelegramMessage(text, TELEGRAM_MAX_LENGTH);
    const numChatId = Number(chatId);
    if (!idempotencyKey) {
      for (const chunk of chunks) await bot.api.sendMessage(numChatId, chunk);
      return;
    }

    const ledgerKey = this.outboundLedgerKey(idempotencyKey, 'text');
    const existing = this.messageLedger.get(ledgerKey);
    if (existing?.state === 'delivered') return;
    if (!existing) this.messageLedger.claim(ledgerKey);

    let nextIndex = 0;
    if (existing?.state === 'ready' && existing.response) {
      const progress = parseOutboundChunkProgress(existing.response);
      nextIndex = progress.nextIndex;
      if (progress.uncertain) {
        console.warn(
          `[Telegram] Retrying delivery ${ledgerKey} from chunk ${nextIndex} after an ` +
            'ambiguous prior acceptance; at-least-once delivery may duplicate that chunk'
        );
      }
    }
    for (let index = nextIndex; index < chunks.length; index += 1) {
      this.messageLedger.markReady(
        ledgerKey,
        JSON.stringify({ version: 1, nextIndex: index, uncertain: true })
      );
      try {
        await bot.api.sendMessage(numChatId, chunks[index]);
      } catch (error) {
        if (isDefiniteTelegramApiRejection(error)) {
          this.messageLedger.markReady(
            ledgerKey,
            JSON.stringify({ version: 1, nextIndex: index, uncertain: false })
          );
        }
        throw error;
      }
      this.messageLedger.markReady(
        ledgerKey,
        JSON.stringify({ version: 1, nextIndex: index + 1, uncertain: false })
      );
    }
    this.messageLedger.markDelivered(ledgerKey);
  }

  async sendFile(
    chatId: string,
    filePath: string,
    caption?: string,
    idempotencyKey?: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const { InputFile } = await import('grammy');
    await this.runInChatQueue(chatId, () =>
      this.sendOutboundOnce(idempotencyKey, 'file', () =>
        this.bot!.api.sendDocument(Number(chatId), new InputFile(filePath), { caption }).then(
          () => {}
        )
      )
    );
  }

  async sendFileFromActiveTurn(
    chatId: string,
    filePath: string,
    caption?: string,
    idempotencyKey?: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const { InputFile } = await import('grammy');
    await this.runInChatQueue(
      chatId,
      () =>
        this.sendOutboundOnce(idempotencyKey, 'file', () =>
          this.bot!.api.sendDocument(Number(chatId), new InputFile(filePath), { caption }).then(
            () => {}
          )
        ),
      true
    );
  }

  async sendImage(
    chatId: string,
    imagePath: string,
    caption?: string,
    idempotencyKey?: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const { InputFile } = await import('grammy');
    await this.runInChatQueue(chatId, () =>
      this.sendOutboundOnce(idempotencyKey, 'image', () =>
        this.bot!.api.sendPhoto(Number(chatId), new InputFile(imagePath), { caption }).then(
          () => {}
        )
      )
    );
  }

  async sendImageFromActiveTurn(
    chatId: string,
    imagePath: string,
    caption?: string,
    idempotencyKey?: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const { InputFile } = await import('grammy');
    await this.runInChatQueue(
      chatId,
      () =>
        this.sendOutboundOnce(idempotencyKey, 'image', () =>
          this.bot!.api.sendPhoto(Number(chatId), new InputFile(imagePath), { caption }).then(
            () => {}
          )
        ),
      true
    );
  }

  private async sendOutboundOnce(
    idempotencyKey: string | undefined,
    kind: string,
    send: () => Promise<void>
  ): Promise<void> {
    if (!idempotencyKey) {
      await send();
      return;
    }
    const ledgerKey = this.outboundLedgerKey(idempotencyKey, kind);
    const existing = this.messageLedger.get(ledgerKey);
    if (existing?.state === 'delivered') return;
    if (!existing) this.messageLedger.claim(ledgerKey);
    await send();
    this.messageLedger.markDelivered(ledgerKey);
  }

  private async recoverPendingInboundDeliveries(): Promise<void> {
    for (const snapshot of this.messageLedger.listUndelivered()) {
      if (snapshot.key.startsWith('outbound:')) continue;
      const separator = snapshot.key.lastIndexOf(':');
      if (separator <= 0) continue;
      const chatId = snapshot.key.slice(0, separator);
      await this.runInChatQueue(chatId, async () => {
        const entry = this.messageLedger.get(snapshot.key);
        if (!entry || entry.state === 'delivered') return;
        if (entry.state === 'processing' && this.messageLedger.isOwnedByCurrentProcess(entry)) {
          return;
        }
        const response =
          entry.state === 'ready' && entry.response !== undefined
            ? entry.response
            : 'The previous processing attempt was interrupted. It was not rerun because its ' +
              'external side effects could not be proven safe to repeat. Please send a new message ' +
              'if you want to retry it.';
        if (entry.state !== 'ready') this.messageLedger.markReady(entry.key, response);
        if (entry.deliveryUncertain) {
          console.warn(
            `[Telegram] Resuming inbound delivery ${entry.key} from uncertain chunk ` +
              `${entry.nextChunkIndex ?? 0}; that chunk may appear twice`
          );
        }
        const presenter = this.createResponsePresenter(
          Number(chatId),
          entry.key,
          entry.nextChunkIndex ?? 0
        );
        await presenter.finalize(response);
        this.messageLedger.markDelivered(entry.key);
      });
    }
  }

  private createResponsePresenter(
    chatId: number,
    messageKey: string,
    resumeFromChunk = 0
  ): TelegramResponsePresenter {
    const api = this.bot!.api;
    return new TelegramResponsePresenter(
      {
        send: async (content) => {
          const sent = await api.sendMessage(chatId, content);
          return String(sent.message_id);
        },
        edit: async (handle, content) => {
          await api.editMessageText(chatId, Number(handle), content);
        },
        delete: async (handle) => {
          await api.deleteMessage(chatId, Number(handle));
        },
      },
      {
        resumeFromChunk,
        onChunkProgress: (nextIndex, uncertain) => {
          if (this.messageLedger.get(messageKey)?.state === 'ready') {
            this.messageLedger.markDeliveryProgress(messageKey, nextIndex, uncertain);
          }
        },
      }
    );
  }

  private outboundLedgerKey(idempotencyKey: string, kind: string): string {
    const digest = createHash('sha256').update(`${kind}\0${idempotencyKey}`).digest('hex');
    return `outbound:${digest}`;
  }

  async sendSticker(chatId: string | number, emotion: string): Promise<boolean> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    return this.runInChatQueue(String(chatId), () => this.sendStickerNow(chatId, emotion));
  }

  async sendStickerFromActiveTurn(chatId: string | number, emotion: string): Promise<boolean> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    return this.runInChatQueue(String(chatId), () => this.sendStickerNow(chatId, emotion), true);
  }

  private async sendStickerNow(chatId: string | number, emotion: string): Promise<boolean> {
    const bot = this.bot;
    if (!bot) throw new Error('Telegram gateway not connected');
    await this.loadStickerSet();

    const candidates = EMOTION_EMOJI[emotion] ?? EMOTION_EMOJI.happy;
    const numChatId = typeof chatId === 'string' ? Number(chatId) : chatId;
    for (const emoji of candidates) {
      const fileId = this.stickerCache.get(emoji);
      if (fileId) {
        await bot.api.sendSticker(numChatId, fileId);
        return true;
      }
    }
    await bot.api.sendMessage(numChatId, candidates[0]);
    return false;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastMessageAt(): number | undefined {
    return this.lastMessageAt;
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
