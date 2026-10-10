import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomInt } from 'node:crypto';
import type { ActionResult } from '@jungjaehoon/mama-core';
import type { MemberSelection } from '../api/member-enrollment.js';
import { closeSync } from 'node:fs';
import { basename } from 'node:path';

import { Bot, InputFile } from 'grammy';
import type { Context } from 'grammy';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { BaseGateway } from './base-gateway.js';
import type { OwnerHostExchangeInput, OwnerMessageInput, TurnIntake } from './turn-contract.js';
import {
  captureTelegramTextFormatting,
  selectTelegramTextEntities,
} from './telegram-text-entities.js';
import {
  formatTelegramMessage,
  isTelegramEntityRejection,
  type TelegramFormattedText,
} from './telegram-format.js';
import {
  TelegramMessageLedger,
  type OwnerMessageLedger,
  type TelegramMessageLedgerEntry,
  DEFAULT_INTERRUPTED_NOTICE,
} from './telegram-message-ledger.js';
import { TelegramResponsePresenter } from './telegram-response-presenter.js';
import {
  OWNER_FILE_MAX_UPLOAD_BYTES,
  openWorkspaceFile,
  readWorkspaceFile,
  workspaceFileIdentity,
  type MemberFileDeliveryContext,
  type TelegramFileDeliveryResult,
} from '../api/file-delivery.js';
import { isDefinitiveTelegramRejection } from './telegram-errors.js';
import { downloadTelegramFiles, telegramFiles } from './telegram-attachments.js';

const TELEGRAM_MAX_LENGTH = 4096;
const MESSAGE_DEDUP_TTL_MS = 60_000;

type TelegramMessage = NonNullable<Context['message']>;
type TelegramApi = Bot['api'];
type SendMessageOther = Parameters<TelegramApi['sendMessage']>[2];
type EditMessageTextOther = Parameters<TelegramApi['editMessageText']>[3];

export interface TelegramGatewayConfig {
  enabled: boolean;
  allowedChats?: string[];
  ownerUserIds?: string[];
  ownerChatId?: string;
  polling?: boolean;
}

export interface TelegramGatewayOptions {
  token: string;
  intake: TurnIntake;
  config?: Partial<TelegramGatewayConfig>;
  messageLedgerPath?: string;
  messageLedger?: OwnerMessageLedger;
  filesRoot?: string;
  downloadsDir?: string;
  log?: (line: string) => void;
  onFatalError?: (error: unknown) => void;
  /** What the owner is told when a turn on their message was cut off. */
  interruptedNotice?: string;
  onMemberSelection?: (selection: MemberSelection) => Promise<ActionResult>;
  /** Store the final transport receipt as history, outside the owner-message intake. */
  recordMemberSelection?: (exchange: OwnerHostExchangeInput) => void;
}

function entityOptions<T>(entities: TelegramFormattedText['entities']): T {
  return { entities } as unknown as T;
}

function telegramErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendErrorIsEntityOnly(error: unknown): boolean {
  return isTelegramEntityRejection(telegramErrorMessage(error));
}

async function sendFormattedMessage(
  api: TelegramApi,
  chatId: number,
  message: TelegramFormattedText
): Promise<{ message_id: number }> {
  if (message.entities.length === 0) return api.sendMessage(chatId, message.text);
  try {
    return await api.sendMessage(
      chatId,
      message.text,
      entityOptions<SendMessageOther>(message.entities)
    );
  } catch (error) {
    if (!sendErrorIsEntityOnly(error)) throw error;
    return api.sendMessage(chatId, message.text);
  }
}

async function editFormattedMessage(
  api: TelegramApi,
  chatId: number,
  messageId: number,
  message: TelegramFormattedText
): Promise<void> {
  if (message.entities.length === 0) {
    await api.editMessageText(chatId, messageId, message.text);
    return;
  }
  try {
    await api.editMessageText(
      chatId,
      messageId,
      message.text,
      entityOptions<EditMessageTextOther>(message.entities)
    );
  } catch (error) {
    if (!sendErrorIsEntityOnly(error)) throw error;
    await api.editMessageText(chatId, messageId, message.text);
  }
}

function sourceMessageRef(chatId: string, messageId: number): string {
  return `telegram:${chatId}:${messageId}`;
}

function chatIdFromSourceMessageRef(value: string): string {
  const prefix = 'telegram:';
  if (!value.startsWith(prefix)) throw new Error('Telegram source message reference is invalid');
  const rest = value.slice(prefix.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0 || !/^\d+$/.test(rest.slice(separator + 1))) {
    throw new Error('Telegram source message reference is invalid');
  }
  return rest.slice(0, separator);
}

function outboundLedgerKey(idempotencyKey: string): string {
  return `outbound:${createHash('sha256').update(`text\0${idempotencyKey}`).digest('hex')}`;
}

/** Telegram owner ingress and its durable response transport. */
export class TelegramGateway extends BaseGateway {
  readonly source = 'telegram' as const;

  private readonly token: string;
  private readonly config: TelegramGatewayConfig;
  private readonly filesRoot?: string;
  private readonly downloadsDir?: string;
  private readonly log: (line: string) => void;
  private readonly interruptedNotice: string;
  private readonly onFatalError: (error: unknown) => void;
  private readonly messageLedger: TelegramMessageLedger;
  private readonly chatTails = new Map<string, Promise<void>>();
  private readonly activePresenters = new Map<string, TelegramResponsePresenter>();
  private readonly recentMessageIds = new Map<string, number>();
  private readonly activeChat = new AsyncLocalStorage<{ chatId: string; active: boolean }>();
  private nextEnrollmentRequestId = randomInt(1, 0x7fffffff);
  private pendingEnrollment?: { requestId: number; sourceMessageRef: string; ownerUserId: string };
  private readonly onMemberSelection?: TelegramGatewayOptions['onMemberSelection'];
  private readonly recordMemberSelection?: TelegramGatewayOptions['recordMemberSelection'];
  private bot: Bot | null = null;
  private lastError: string | null = null;
  private lastMessageAt: number | undefined;

  protected get mentionPattern(): RegExp | null {
    return null;
  }

  constructor(options: TelegramGatewayOptions) {
    super({ intake: options.intake });
    this.token = options.token;
    this.onMemberSelection = options.onMemberSelection;
    this.recordMemberSelection = options.recordMemberSelection;
    this.config = {
      enabled: options.config?.enabled ?? true,
      allowedChats: options.config?.allowedChats ?? [],
      ...(options.config?.ownerUserIds === undefined
        ? {}
        : { ownerUserIds: options.config.ownerUserIds }),
      ...(options.config?.ownerChatId === undefined
        ? {}
        : { ownerChatId: options.config.ownerChatId }),
      ...(options.config?.polling === undefined ? {} : { polling: options.config.polling }),
    };
    this.filesRoot = options.filesRoot;
    this.downloadsDir = options.downloadsDir;
    this.onFatalError =
      options.onFatalError ??
      ((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    this.log = options.log ?? ((line) => console.log(line));
    this.interruptedNotice = options.interruptedNotice ?? DEFAULT_INTERRUPTED_NOTICE;
    const ledgerPath = options.messageLedgerPath ?? process.env.MAMA_TELEGRAM_MESSAGE_LEDGER_PATH;
    if (!options.messageLedger && !ledgerPath?.trim()) {
      throw new Error('Telegram message ledger path is required');
    }
    this.messageLedger =
      options.messageLedger ?? new TelegramMessageLedger(ledgerPath!, { log: this.log });
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (!this.config.allowedChats?.some((chatId) => chatId.trim().length > 0)) {
      throw new Error('telegram gateway disabled: allowed_chats is not set. Run: mama status');
    }
    if (!this.token.trim()) throw new Error('telegram gateway requires a token');

    try {
      this.bot = new Bot(this.token);
      this.bot.on('message', async (ctx: Context) => {
        if (ctx.message) await this.handleMessage(ctx.message);
      });
      this.bot.catch((error) => {
        this.lastError = telegramErrorMessage(error);
        console.error(`telegram handler failed error=${this.lastError}`);
      });
      await this.bot.init();
      this.connected = true;
      this.lastError = null;
      this.emitEvent({ type: 'connected', source: 'telegram', timestamp: new Date() });
      await this.recoverPendingResponses();
      if (this.config.polling !== false) {
        // Polling runs for the life of the process; a failure here means no owner message
        // is ever received, so it is logged, not swallowed.
        this.bot.start().catch((error: unknown) => {
          this.lastError = telegramErrorMessage(error);
          this.connected = false;
          console.error(`telegram polling stopped error=${this.lastError}`);
          this.onFatalError(error);
        });
        console.log(`telegram polling started polling=${this.config.polling ?? 'default'}`);
      } else {
        console.log('telegram polling disabled by config');
      }
    } catch (error) {
      this.lastError = telegramErrorMessage(error);
      if (this.bot) await this.bot.stop().catch(() => {});
      this.bot = null;
      this.connected = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.pendingEnrollment = undefined;
    if (this.bot) await this.bot.stop().catch(() => {});
    this.bot = null;
    this.connected = false;
    this.recentMessageIds.clear();
    this.emitEvent({ type: 'disconnected', source: 'telegram', timestamp: new Date() });
  }

  /** Delivered inbound identities; message and answer text stay in the durable runtime journal. */

  answered(sourceRef: string): boolean {
    return this.messageLedger.get(sourceRef)?.state === 'delivered';
  }

  /** Final response callback used by the owner runtime after a native turn settles. */
  async deliverResponse(sourceRef: string, response: string): Promise<void> {
    const chatId = chatIdFromSourceMessageRef(sourceRef);
    this.requireAllowedChat(chatId);
    const existing = this.messageLedger.get(sourceRef);
    if (!existing) throw new Error(`Telegram response has no accepted message ${sourceRef}`);
    if (existing.deliveryTarget && existing.deliveryTarget !== `telegram:${chatId}`) {
      throw new Error('Telegram response destination conflicts with its accepted message');
    }
    if (existing.state === 'delivered') return;
    if (existing.state === 'ready' && existing.response !== response) {
      throw new Error('Telegram response conflicts with its durable ledger entry');
    }
    if (existing.state === 'processing')
      this.messageLedger.markReady(sourceRef, response, 'html-v1');
    if (!this.bot || !this.connected) return;
    await this.deliverReadyEntry(sourceRef);
  }

  async sendMessage(chatId: string, text: string, idempotencyKey?: string): Promise<void> {
    if (!this.bot || !this.connected) throw new Error('Telegram gateway not connected');
    this.requireAllowedChat(chatId);
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.runInChatQueue(chatId, () => this.sendMessageNow(chatId, trimmed, idempotencyKey));
  }

  async sendToOwner(text: string, idempotencyKey: string): Promise<void> {
    const ownerChatId = this.config.ownerChatId?.trim();
    if (!ownerChatId) throw new Error('telegram.owner_chat_id is required for delta delivery');
    await this.sendMessage(ownerChatId, text, idempotencyKey);
  }

  async sendFile(
    path: string,
    caption: string | undefined,
    operationId: string,
    member?: MemberFileDeliveryContext
  ): Promise<TelegramFileDeliveryResult> {
    if (!this.bot || !this.connected) throw new Error('Telegram gateway not connected');
    if (operationId.trim() === '') throw new Error('Telegram file operation id is required');
    let chatId: string;
    let filesRoot: string;
    if (member) {
      // Only the registry-resolved DM bypasses the owner's file allowlist; input cannot name it.
      const destinations = member.access.destinations?.filter(
        (target) => target.kind === 'telegram'
      );
      if (destinations?.length !== 1 || !destinations[0]!.id.trim())
        throw new Error('Member file delivery requires exactly one Telegram destination');
      chatId = destinations[0]!.id;
      filesRoot = member.filesRoot;
    } else {
      const ownerChatId = this.config.ownerChatId?.trim();
      if (!ownerChatId) throw new Error('telegram.owner_chat_id is required for file delivery');
      this.requireAllowedChat(ownerChatId);
      if (!this.filesRoot) throw new Error('Telegram workspace files root is not configured');
      chatId = ownerChatId;
      filesRoot = this.filesRoot;
    }

    const validated = openWorkspaceFile(
      filesRoot,
      path,
      OWNER_FILE_MAX_UPLOAD_BYTES,
      member !== undefined
    );
    try {
      const payloadIdentity = workspaceFileIdentity(validated.fd, caption);
      const claim = this.messageLedger.claim(`file:${operationId}`, {
        deliveryTarget: `telegram:${chatId}`,
        payloadIdentity,
      });
      if (!claim.claimed) {
        if (claim.entry.state === 'delivered') {
          return {
            sentAs: validated.sentAs,
            size: validated.size,
            idempotent: true,
          };
        }
        throw new Error('Telegram file delivery operation is already in progress or uncertain');
      }

      const upload = new InputFile(readWorkspaceFile(validated.fd), basename(validated.path));
      try {
        const sent =
          validated.sentAs === 'photo'
            ? await this.bot.api.sendPhoto(
                chatId,
                upload,
                caption === undefined ? undefined : { caption }
              )
            : await this.bot.api.sendDocument(
                chatId,
                upload,
                caption === undefined ? undefined : { caption }
              );
        this.messageLedger.markDelivered(`file:${operationId}`);
        return {
          messageId: sent.message_id,
          sentAs: validated.sentAs,
          size: validated.size,
        };
      } catch (error) {
        this.messageLedger.markFailed(`file:${operationId}`);
        throw error;
      }
    } finally {
      closeSync(validated.fd);
    }
  }

  /** The source ref was verified as an owner turn by the runtime; only an owner DM can select. */
  async requestMemberEnrollment(sourceRef: string): Promise<void> {
    if (!sourceRef.startsWith('telegram:'))
      throw Object.assign(new Error("Enrollment requires the owner's own Telegram DM"), {
        name: 'denied',
      });
    const ownerUserId = chatIdFromSourceMessageRef(sourceRef);
    const chatId = Number(ownerUserId);
    if (!this.bot || !this.onMemberSelection || !this.ownerAllowed(ownerUserId, ownerUserId)) {
      throw Object.assign(new Error("Enrollment requires the owner's own Telegram DM"), {
        name: 'denied',
      });
    }
    const requestId = this.nextEnrollmentRequestId;
    this.nextEnrollmentRequestId = requestId === 0x7fffffff ? 1 : requestId + 1;
    this.pendingEnrollment = { requestId, sourceMessageRef: sourceRef, ownerUserId };
    // Telegram shows a request_users button only on the reply keyboard, under the message box.
    const prompt =
      'Choose one member to enroll with the Choose member button under the message box, not in the chat. If it is hidden, open it with the keyboard icon in the message box.';
    try {
      await this.bot.api.sendMessage(chatId, prompt, {
        reply_markup: {
          one_time_keyboard: true,
          resize_keyboard: true,
          keyboard: [
            [
              {
                text: 'Choose member',
                request_users: { request_id: requestId, user_is_bot: false, max_quantity: 1 },
              },
            ],
          ],
        },
      });
    } catch (error) {
      if (this.pendingEnrollment?.requestId === requestId) this.pendingEnrollment = undefined;
      throw error;
    }
  }

  private async completeMemberSelection(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const ownerUserId = String(message.from!.id);
    if (message.chat.type !== 'private' || chatId !== ownerUserId) return;
    let receiptText = 'Enrollment selection received.';
    let deliveryVerified = false;
    const sendReceipt = async (text: string): Promise<void> => {
      receiptText = text;
      deliveryVerified = false;
      await this.bot!.api.sendMessage(Number(chatId), text, {
        reply_markup: { remove_keyboard: true },
      });
      deliveryVerified = true;
    };
    try {
      const pending = this.pendingEnrollment;
      const shared = message.users_shared!;
      if (
        !pending ||
        shared.request_id !== pending.requestId ||
        ownerUserId !== pending.ownerUserId
      ) {
        await sendReceipt(
          'Enrollment refused: principal=none connector=telegram namespace=private. No matching pending request; ask again.'
        );
        return;
      }
      // Consume before awaiting the serial host chain, so concurrent duplicate updates cannot enroll.
      this.pendingEnrollment = undefined;
      if (
        shared.users.length !== 1 ||
        !Number.isSafeInteger(shared.users[0]!.user_id) ||
        shared.users[0]!.user_id <= 0
      ) {
        await sendReceipt(
          'Enrollment refused: principal=none connector=telegram namespace=private. Choose exactly one user; ask again.'
        );
        return;
      }
      await sendReceipt('Enrollment selection received.');
      let result: ActionResult;
      try {
        result = await this.onMemberSelection!({
          sourceMessageRef: pending.sourceMessageRef,
          ownerUserId,
          userId: String(shared.users[0]!.user_id),
        });
      } catch (error) {
        // The request is already consumed; the owner must still learn the outcome.
        console.error('[telegram] member enrollment failed');
        result = {
          status: 'failed',
          error: {
            kind: 'internal',
            code: 'enrollment_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      const data =
        result.status === 'completed'
          ? (result.data as {
              status: string;
              principalId: string | null;
              connector: string;
              namespace: string;
              message?: string;
            })
          : {
              status: 'refused',
              principalId: null,
              connector: 'telegram',
              namespace: 'private',
              message: result.error.message,
            };
      await sendReceipt(
        `Enrollment ${data.status}: principal=${data.principalId ?? 'none'} connector=${data.connector} namespace=${data.namespace}${data.message ? `. ${data.message}` : ''}`
      );
    } finally {
      // The gateway owns every outcome and the exact last text it tried to deliver.
      // Never pass users_shared payloads to conversation storage or owner-message intake.
      try {
        this.recordMemberSelection?.({
          message: {
            id: sourceMessageRef(chatId, message.message_id),
            channelKey: chatId,
            occurredAt: message.date * 1000,
            text: 'Member selection for enrollment (Choose member button)',
            // manage.member.list finds the receipts by this marker, not by the text.
            payload: { enrollmentSelection: true },
          },
          reply: { text: receiptText, occurredAt: Date.now(), deliveryVerified },
        });
      } catch (error) {
        // A throw from finally would replace a send error already in flight; both must surface.
        console.error(
          `[telegram] enrollment receipt record failed: ${telegramErrorMessage(error)}`
        );
      }
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastMessageAt(): number | undefined {
    return this.lastMessageAt;
  }

  private ownerAllowed(chatId: string, userId: string): boolean {
    if (!this.config.allowedChats?.includes(chatId)) return false;
    if (this.config.ownerUserIds !== undefined) return this.config.ownerUserIds.includes(userId);
    return this.config.allowedChats.length === 1 && this.config.allowedChats[0] === userId;
  }

  private requireAllowedChat(chatId: string): void {
    if (!this.config.allowedChats?.includes(chatId)) {
      throw new Error('Telegram destination is not allowlisted');
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.chat || !message.from) return;
    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    if (message.from.is_bot || !this.ownerAllowed(chatId, userId)) {
      const chatHash = createHash('sha256').update(`chat\0${chatId}`).digest('hex');
      const senderHash = createHash('sha256').update(`sender\0${userId}`).digest('hex');
      console.warn(
        `telegram message dropped reason=non_owner chat_hash=${chatHash} sender_hash=${senderHash}`
      );
      return;
    }

    if (message.users_shared) {
      await this.completeMemberSelection(message);
      return;
    }

    const ref = sourceMessageRef(chatId, message.message_id);
    const now = Date.now();
    const previous = this.recentMessageIds.get(ref);
    if (previous !== undefined && now - previous <= MESSAGE_DEDUP_TTL_MS) return;
    this.recentMessageIds.set(ref, now);
    for (const [key, timestamp] of this.recentMessageIds) {
      if (now - timestamp > MESSAGE_DEDUP_TTL_MS) this.recentMessageIds.delete(key);
    }

    const durable = this.messageLedger.get(ref);
    if (durable?.state === 'delivered') return;
    if (durable?.state === 'ready') {
      await this.deliverReadyEntry(ref);
      return;
    }
    if (durable?.state === 'processing' && this.activePresenters.has(ref)) return;
    if (durable?.state === 'processing' && this.intake.isPending?.(ref)) return;
    if (durable?.state === 'processing') {
      this.messageLedger.markInterrupted(ref, this.interruptedNotice, 'html-v1');
      await this.deliverReadyEntry(ref);
      return;
    }

    const selected = selectTelegramTextEntities(message);
    const files = telegramFiles(message);
    if (!selected.text.trim() && files.length === 0) return;
    const formatting = captureTelegramTextFormatting(
      selected.field,
      selected.text,
      selected.entities
    );
    const inputIdentity = createHash('sha256')
      .update(`${selected.text}\0${files.map(({ file }) => file.file_unique_id).join(',')}`)
      .digest('hex');
    const ledgerEntry = this.messageLedger.claim(ref, {
      deliveryTarget: `telegram:${chatId}`,
      payloadIdentity: inputIdentity,
    }).entry;
    const presenter = this.createResponsePresenter(ref, Number(message.chat.id));
    this.activePresenters.set(ref, presenter);
    try {
      if (ledgerEntry.state !== 'ready') await presenter.start();
      const attachments = await downloadTelegramFiles(files, {
        api: this.bot!.api,
        token: this.token,
        downloadsDir: this.downloadsDir,
        messageId: message.message_id,
      });
      const input: OwnerMessageInput = {
        id: ref,
        channelKey: chatId,
        occurredAt: message.date * 1000,
        text: selected.text.trim()
          ? selected.text
          : attachments.map(({ name }) => `[file: ${name}]`).join('\n'),
        ...(formatting === undefined && attachments.length === 0
          ? {}
          : {
              payload: {
                ...(formatting === undefined ? {} : { telegramFormatting: formatting }),
                ...(attachments.length === 0 ? {} : { attachments }),
              } as unknown as JsonValue,
            }),
      };
      this.intake.acceptOwnerMessage(input);
      this.emitEvent({
        type: 'message_received',
        source: 'telegram',
        timestamp: new Date(),
        data: { sourceMessageRef: ref },
      });
    } catch (error) {
      this.activePresenters.delete(ref);
      throw error;
    }
  }

  private createResponsePresenter(sourceRef: string, chatId: number): TelegramResponsePresenter {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    return new TelegramResponsePresenter(
      {
        send: (content) =>
          sendFormattedMessage(this.bot!.api, chatId, content).then((sent) =>
            String(sent.message_id)
          ),
        edit: (handle, content) =>
          editFormattedMessage(this.bot!.api, chatId, Number(handle), content),
        delete: async (handle) => {
          await this.bot!.api.deleteMessage(chatId, Number(handle));
        },
      },
      {
        log: this.log,
        resumeFromChunk: this.messageLedger.get(sourceRef)?.nextChunkIndex ?? 0,
        chunkFormat: this.messageLedger.get(sourceRef)?.chunkFormat ?? 'html-v1',
        withDelivery: (send) => this.runInChatQueue(String(chatId), send, true),
        onChunkProgress: (nextIndex, uncertain) => {
          const entry = this.messageLedger.get(sourceRef);
          if (entry?.state === 'ready') {
            this.messageLedger.markDeliveryProgress(sourceRef, nextIndex, uncertain);
          }
        },
      }
    );
  }

  private async deliverReadyEntry(sourceRef: string): Promise<void> {
    const entry = this.messageLedger.get(sourceRef);
    if (!entry || entry.state === 'delivered') return;
    if (entry.response === undefined) throw new Error('Telegram ready entry has no response');
    const chatId = Number(chatIdFromSourceMessageRef(sourceRef));
    await this.runInChatQueue(String(chatId), async () => {
      const current = this.messageLedger.get(sourceRef);
      if (!current || current.state === 'delivered') return;
      if (current.deliveryUncertain) throw new Error('Telegram response delivery is uncertain');
      const presenter =
        this.activePresenters.get(sourceRef) ?? this.createResponsePresenter(sourceRef, chatId);
      try {
        await presenter.finalize(current.response!);
      } finally {
        this.activePresenters.delete(sourceRef);
      }
      // All chunks are confirmed; archive before the ledger drops the ready text.
      // Legacy ready entries cannot distinguish an agent reply from a host notice.
      if (current.responseAuthor === undefined) {
        this.log(`telegram reply archive skipped key=${sourceRef} reason=missing_response_author`);
      } else {
        this.intake.recordOwnerReply({
          messageRef: sourceRef,
          text: current.response!,
          occurredAt: this.messageLedger.get(sourceRef)!.updatedAt,
          author: current.responseAuthor,
          deliveryVerified: true,
        });
      }
      this.messageLedger.markDelivered(sourceRef);
      this.lastMessageAt = Date.now();
      this.emitEvent({
        type: 'message_sent',
        source: 'telegram',
        timestamp: new Date(),
        data: { sourceMessageRef: sourceRef },
      });
    });
  }

  async recoverPendingResponses(): Promise<void> {
    for (const entry of this.messageLedger.listUndelivered()) {
      try {
        if (entry.deliveryUncertain) {
          this.log(
            `telegram delivery requires reconciliation key=${entry.key} state=${entry.state} next_chunk_index=${entry.nextChunkIndex ?? 0}`
          );
          continue;
        }
        if (entry.key.startsWith('outbound:') && entry.state === 'ready') {
          const chatId = entry.deliveryTarget?.slice('telegram:'.length);
          if (!entry.deliveryTarget?.startsWith('telegram:') || !chatId) {
            throw new Error('Telegram outbound entry has no valid destination');
          }
          if (!this.config.allowedChats?.includes(chatId)) continue;
          await this.runInChatQueue(chatId, () => this.deliverOutboundEntry(entry.key, chatId));
          continue;
        }
        if (!entry.key.startsWith('telegram:')) continue;
        const chatId = chatIdFromSourceMessageRef(entry.key);
        if (!this.config.allowedChats?.includes(chatId)) continue;
        if (entry.state === 'ready' && entry.response !== undefined) {
          await this.deliverReadyEntry(entry.key);
          continue;
        }
        if (entry.state === 'processing' && !this.intake.isPending?.(entry.key)) {
          this.messageLedger.markInterrupted(entry.key, this.interruptedNotice, 'html-v1');
          await this.deliverReadyEntry(entry.key);
        }
      } catch (error) {
        // Delivery already recorded its progress; one entry must not keep polling from starting.
        this.log(`telegram recovery failed key=${entry.key} error=${telegramErrorMessage(error)}`);
      }
    }
  }

  private async sendMessageNow(
    chatId: string,
    text: string,
    idempotencyKey?: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const chunks = formatTelegramMessage(text, TELEGRAM_MAX_LENGTH, 'html-v1');
    if (!idempotencyKey) {
      for (const chunk of chunks) await sendFormattedMessage(this.bot.api, Number(chatId), chunk);
      return;
    }

    const key = outboundLedgerKey(idempotencyKey);
    const binding = {
      deliveryTarget: `telegram:${chatId}`,
      payloadIdentity: createHash('sha256').update(text).digest('hex'),
      idempotencyKey,
      keepDeliveredOnPayloadChange: true,
    };
    const existing = this.messageLedger.claim(key, binding).entry;
    if (existing.state === 'delivered') return;
    if (existing.state !== 'ready') this.messageLedger.markReady(key, text, 'html-v1');
    await this.deliverOutboundEntry(key, chatId);
  }

  private async deliverOutboundEntry(key: string, chatId: string): Promise<void> {
    const entry = this.messageLedger.get(key);
    if (!entry) throw new Error(`Telegram outbound entry is missing: ${key}`);
    if (entry.state === 'delivered') return;
    if (entry.deliveryUncertain) throw new Error('Telegram outbound delivery is uncertain');
    if (!this.bot) throw new Error('Telegram gateway not connected');
    if (entry.response === undefined) throw new Error('Telegram outbound entry has no response');
    // markReady persists both fields; inventing them could resend chunks or change their formatting.
    if (entry.chunkFormat === undefined || entry.nextChunkIndex === undefined) {
      throw new Error('Telegram outbound entry has incomplete delivery metadata');
    }
    const chunks = formatTelegramMessage(entry.response, TELEGRAM_MAX_LENGTH, entry.chunkFormat);
    const start = entry.nextChunkIndex;
    for (let index = start; index < chunks.length; index += 1) {
      this.messageLedger.markDeliveryProgress(key, index, true);
      try {
        const sent = await sendFormattedMessage(this.bot.api, Number(chatId), chunks[index]!);
        this.messageLedger.markDeliveryProgress(key, index + 1, false, sent.message_id);
      } catch (error) {
        if (isDefinitiveTelegramRejection(error)) {
          this.messageLedger.markDeliveryProgress(key, index, false);
        }
        throw error;
      }
    }
    this.messageLedger.markDelivered(key);
    this.log(
      `telegram outbound delivered idempotency_key=${JSON.stringify(entry.idempotencyKey)} message_ids=${JSON.stringify(this.messageLedger.get(key)!.messageIds ?? [])}`
    );
  }

  private async runInChatQueue<T>(
    chatId: string,
    work: () => Promise<T>,
    allowReentrant = false
  ): Promise<T> {
    const active = this.activeChat.getStore();
    if (allowReentrant && active?.active && active.chatId === chatId) return work();
    const previous = this.chatTails.get(chatId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(() => gate);
    this.chatTails.set(chatId, current);
    try {
      if (previous) await previous.catch(() => {});
      return await this.activeChat.run({ chatId, active: true }, work);
    } finally {
      release();
      if (this.chatTails.get(chatId) === current) this.chatTails.delete(chatId);
    }
  }
}

export type { TelegramMessageLedgerEntry };
