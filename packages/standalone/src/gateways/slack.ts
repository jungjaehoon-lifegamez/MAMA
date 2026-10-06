import { createHash } from 'node:crypto';
import { closeSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { BaseGateway } from './base-gateway.js';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { OwnerMessageInput, TurnIntake } from './turn-contract.js';
import { DEFAULT_INTERRUPTED_NOTICE, OwnerMessageLedger } from './telegram-message-ledger.js';
import { splitForSlack } from './message-splitter.js';
import {
  OWNER_FILE_MAX_UPLOAD_BYTES,
  openWorkspaceFile,
  workspaceFileIdentity,
} from '../api/file-delivery.js';
import type { OwnerFileDeliveryResult } from '../api/file-delivery.js';
import { saveResponseBody } from '../connectors/framework/attachment-io.js';
import { safeFileName } from '../api/attachment-actions.js';

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}
interface SlackMessageEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  text?: string;
  thread_ts?: string;
  files?: SlackFile[];
}
export interface SlackGatewayOptions {
  token: string;
  appToken: string;
  intake: TurnIntake;
  config: {
    enabled: boolean;
    ownerChannelId?: string;
    allowedChannels: string[];
    ownerUserIds: string[];
  };
  messageLedgerPath: string;
  messageLedger?: OwnerMessageLedger;
  downloadsDir?: string;
  filesRoot?: string;
  log?: (line: string) => void;
  /** What the owner is told when a turn on their message was cut off. */
  interruptedNotice?: string;
}

/** Owner-only Slack Socket Mode transport. */
export class SlackGateway extends BaseGateway {
  readonly source = 'slack' as const;
  private readonly socket: SocketModeClient;
  private readonly api: WebClient;
  private readonly ledger: OwnerMessageLedger;
  private readonly log: (line: string) => void;
  private readonly interruptedNotice: string;
  private readonly activeInputs = new Set<string>();
  private readonly deliveryTails = new Map<string, Promise<void>>();

  constructor(private readonly options: SlackGatewayOptions) {
    super({ intake: options.intake });
    this.log = options.log ?? console.log;
    this.interruptedNotice = options.interruptedNotice ?? DEFAULT_INTERRUPTED_NOTICE;
    this.socket = new SocketModeClient({ appToken: options.appToken });
    this.api = new WebClient(options.token);
    this.ledger =
      options.messageLedger ?? new OwnerMessageLedger(options.messageLedgerPath, { log: this.log });
    this.socket.on('connected', () => {
      this.connected = true;
      this.emitEvent({ type: 'connected', source: this.source, timestamp: new Date() });
    });
    this.socket.on('disconnected', () => {
      this.connected = false;
      this.emitEvent({ type: 'disconnected', source: this.source, timestamp: new Date() });
    });
    this.socket.on('message', async ({ event, ack }) => {
      try {
        await this.accept(event as SlackMessageEvent);
        await ack();
      } catch (error) {
        this.emitEvent({
          type: 'error',
          source: this.source,
          timestamp: new Date(),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
    this.socket.on('app_mention', async ({ event, ack }) => {
      try {
        await this.accept(event as SlackMessageEvent);
        await ack();
      } catch (error) {
        this.emitEvent({
          type: 'error',
          source: this.source,
          timestamp: new Date(),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (!this.options.config.allowedChannels.length || !this.options.config.ownerUserIds.length)
      throw new Error('slack owner allowlist is not configured');
    if (!this.options.token.trim()) throw new Error('MAMA_SLACK_TOKEN is required');
    if (!this.options.appToken.trim()) throw new Error('MAMA_SLACK_APP_TOKEN is required');
    await this.socket.start();
    this.connected = true;
    await this.recoverPendingResponses();
  }
  async stop(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.socket.disconnect();
    this.emitEvent({ type: 'disconnected', source: this.source, timestamp: new Date() });
  }

  answered(sourceRef: string): boolean {
    return this.ledger.get(sourceRef)?.state === 'delivered';
  }
  async recoverPendingResponses(): Promise<void> {
    for (const entry of this.ledger.listUndelivered()) {
      try {
        const channel = entry.deliveryTarget?.startsWith('slack:')
          ? entry.deliveryTarget.slice('slack:'.length)
          : '';
        const source = entry.key.startsWith('slack:');
        const outbound = entry.key.startsWith('outbound:') || entry.key.startsWith('file:');
        if (
          (!source && !outbound) ||
          !channel ||
          !this.options.config.allowedChannels.includes(channel)
        )
          continue;
        if (entry.deliveryUncertain) {
          this.log(`slack delivery requires reconciliation key=${entry.key}`);
          continue;
        }
        if (source && entry.state === 'processing' && !this.intake.isPending?.(entry.key)) {
          this.ledger.markInterrupted(entry.key, this.interruptedNotice);
          await this.deliverResponse(entry.key, this.interruptedNotice);
        } else if (entry.state === 'ready' && entry.response !== undefined) {
          if (source) await this.deliverResponse(entry.key, entry.response);
          else
            await this.runInDestination(channel, () =>
              this.sendChunks(channel, entry.key, entry.response!)
            );
        }
      } catch (error) {
        this.log(
          `slack recovery failed key=${entry.key} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  async deliverResponse(sourceRef: string, response: string): Promise<void> {
    const channel = sourceRefChannel(sourceRef);
    this.requireAllowed(channel);
    const entry = this.ledger.get(sourceRef);
    if (!entry) throw new Error(`Slack response has no accepted message ${sourceRef}`);
    if (entry.deliveryTarget !== `slack:${channel}`)
      throw new Error('Slack response destination conflicts with its accepted message');
    if (entry.state === 'delivered') return;
    // Confirmed chunks must continue with the same durable response.
    if (entry.state === 'ready' && entry.response !== response)
      throw new Error('Ready reply conflicts with its durable ledger entry');
    if (entry.state === 'processing') this.ledger.markReady(sourceRef, response);
    await this.runInDestination(channel, () => this.sendChunks(channel, sourceRef, response));
  }
  async sendMessage(channel: string, text: string, idempotencyKey?: string): Promise<void> {
    this.requireConnected();
    this.requireAllowed(channel);
    const key = `outbound:${createHash('sha256')
      .update(`text\0${idempotencyKey ?? `${channel}:${text}`}`)
      .digest('hex')}`;
    const claim = this.ledger.claim(key, {
      deliveryTarget: `slack:${channel}`,
      payloadIdentity: createHash('sha256').update(text).digest('hex'),
      keepDeliveredOnPayloadChange: true,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (!claim.claimed) {
      if (claim.entry.state === 'delivered') return;
      throw new Error('Slack message delivery is already in progress or uncertain');
    }
    this.ledger.markReady(key, text);
    await this.runInDestination(channel, () => this.sendChunks(channel, key, text));
  }
  async sendToOwner(text: string, key: string): Promise<void> {
    const channel = this.options.config.ownerChannelId;
    if (!channel) throw new Error('slack.owner_channel_id is required');
    await this.sendMessage(channel, text, key);
  }
  async sendFile(
    path: string,
    caption: string | undefined,
    operationId: string
  ): Promise<OwnerFileDeliveryResult> {
    this.requireConnected();
    if (!operationId.trim()) throw new Error('Slack file operation id is required');
    const channel = this.options.config.ownerChannelId;
    if (!channel) throw new Error('slack.owner_channel_id is required');
    this.requireAllowed(channel);
    if (!this.options.filesRoot) throw new Error('Slack workspace files root is not configured');
    const file = openWorkspaceFile(this.options.filesRoot, path, OWNER_FILE_MAX_UPLOAD_BYTES);
    const key = `file:${operationId}`;
    try {
      const identity = workspaceFileIdentity(file.fd, caption);
      const claim = this.ledger.claim(key, {
        deliveryTarget: `slack:${channel}`,
        payloadIdentity: identity,
        idempotencyKey: operationId,
      });
      if (!claim.claimed) {
        if (claim.entry.state === 'delivered')
          return { sentAs: file.sentAs, size: file.size, idempotent: true };
        throw new Error('Slack file delivery is already in progress or uncertain');
      }
      const result = (await this.runInDestination(channel, () =>
        this.api.files.uploadV2({
          channel_id: channel,
          file: readFileSync(file.fd),
          filename: basename(file.path),
          ...(caption === undefined ? {} : { initial_comment: caption }),
        })
      )) as { files?: Array<{ id?: string }> };
      const id = result.files?.[0]?.id;
      this.ledger.markDelivered(key);
      return { ...(id ? { messageId: id } : {}), sentAs: file.sentAs, size: file.size };
    } catch (error) {
      if (this.ledger.get(key)?.state === 'processing') this.ledger.markFailed(key);
      throw error;
    } finally {
      closeSync(file.fd);
    }
  }

  private async accept(event: SlackMessageEvent): Promise<void> {
    if (
      !event.channel ||
      !event.ts ||
      !event.user ||
      event.bot_id ||
      (event.subtype && event.subtype !== 'file_share')
    )
      return;
    const channel = event.channel;
    const user = event.user;
    if (
      !this.options.config.allowedChannels.includes(channel) ||
      !this.options.config.ownerUserIds.includes(user)
    ) {
      this.log(
        `slack message dropped reason=non_owner channel_hash=${hash('channel', channel)} sender_hash=${hash('sender', user)}`
      );
      return;
    }
    const ref = `slack:${channel}:${event.ts}`;
    if (this.activeInputs.has(ref)) return;
    const existing = this.ledger.get(ref);
    if (existing) {
      if (existing.state === 'ready') await this.deliverResponse(ref, existing.response ?? '');
      return;
    }
    const files = event.files ?? [];
    if (!event.text?.trim() && !files.length) return;
    const identity = createHash('sha256')
      .update(
        `${event.text ?? ''}\0${files
          .map((file) => file.id)
          .sort()
          .join(',')}`
      )
      .digest('hex');
    this.ledger.claim(ref, { deliveryTarget: `slack:${channel}`, payloadIdentity: identity });
    this.activeInputs.add(ref);
    try {
      const attachments = await Promise.all(
        files.map(async (file) => {
          let name = file.name || file.id;
          try {
            name = safeFileName(name);
            if (!this.options.downloadsDir)
              throw new Error('Attachment downloads directory is not configured');
            if (!file.url_private_download) throw new Error('Slack file has no download URL');
            const response = await fetch(file.url_private_download, {
              headers: { Authorization: `Bearer ${this.options.token}` },
              signal: AbortSignal.timeout(60_000),
            });
            if (!response.ok)
              throw new Error(`Slack attachment download failed (HTTP ${response.status})`);
            const path = join(
              this.options.downloadsDir,
              'slack',
              `${safeFileName(event.ts!)}_${safeFileName(file.id)}_${name}`
            );
            const size = await saveResponseBody(response, path);
            return { name, path, size, ...(file.mimetype ? { mimeType: file.mimetype } : {}) };
          } catch (error) {
            return { name, error: error instanceof Error ? error.message : String(error) };
          }
        })
      );
      const input: OwnerMessageInput = {
        id: ref,
        channelKey: channel,
        occurredAt: Math.floor(Number(event.ts) * 1000),
        text: event.text?.trim() || attachments.map((file) => `[file: ${file.name}]`).join('\n'),
        ...(event.thread_ts ? { replyTo: `slack:${channel}:${event.thread_ts}` } : {}),
        ...(attachments.length ? { payload: { attachments } as unknown as JsonValue } : {}),
      };
      this.intake.acceptOwnerMessage(input);
      this.emitEvent({
        type: 'message_received',
        source: this.source,
        timestamp: new Date(input.occurredAt),
        data: { sourceMessageRef: ref },
      });
    } finally {
      this.activeInputs.delete(ref);
    }
  }
  private async sendChunks(channel: string, key: string, text: string): Promise<void> {
    const entry = this.ledger.get(key)!;
    // Another response call may have completed while this batch waited in the destination queue.
    if (entry.state === 'delivered') return;
    if (entry.deliveryUncertain) throw new Error('Slack response delivery is uncertain');
    const chunks = splitForSlack(text);
    for (let i = entry.nextChunkIndex ?? 0; i < chunks.length; i++) {
      this.ledger.markDeliveryProgress(key, i, true);
      try {
        const sent = await this.api.chat.postMessage({ channel, text: chunks[i]! });
        this.ledger.markDeliveryProgress(key, i + 1, false, sent.ts);
      } catch (error) {
        this.ledger.markDeliveryProgress(key, i, true);
        throw error;
      }
    }
    // Outbound reports and file deliveries have no owner message to answer.
    if (key.startsWith('slack:')) {
      // Legacy ready entries cannot distinguish an agent reply from a host notice.
      if (entry.responseAuthor === undefined) {
        this.log(`slack reply archive skipped key=${key} reason=missing_response_author`);
      } else {
        this.intake.recordOwnerReply({
          messageRef: key,
          text: entry.response!,
          occurredAt: this.ledger.get(key)!.updatedAt,
          author: entry.responseAuthor,
          deliveryVerified: true,
        });
      }
    }
    this.ledger.markDelivered(key);
    this.emitEvent({
      type: 'message_sent',
      source: this.source,
      timestamp: new Date(),
      data: { sourceMessageRef: key },
    });
  }
  private async runInDestination<T>(destination: string, work: () => Promise<T>): Promise<T> {
    const previous = this.deliveryTails.get(destination) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.deliveryTails.set(destination, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.deliveryTails.get(destination) === tail) this.deliveryTails.delete(destination);
    }
  }
  private requireAllowed(channel: string): void {
    if (!this.options.config.allowedChannels.includes(channel))
      throw new Error('Slack destination is not allowlisted');
  }
  private requireConnected(): void {
    if (!this.connected) throw new Error('Slack gateway not connected');
  }
}
function sourceRefChannel(value: string): string {
  if (!value.startsWith('slack:')) throw new Error('Slack source message reference is invalid');
  const parts = value.split(':');
  if (parts.length !== 3) throw new Error('Slack source message reference is invalid');
  return parts[1]!;
}
function hash(kind: string, value: string): string {
  return createHash('sha256').update(`${kind}\0${value}`).digest('hex');
}
