import { createHash } from 'node:crypto';
import { closeSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AttachmentBuilder, Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { BaseGateway } from './base-gateway.js';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { OwnerMessageInput, TurnIntake } from './turn-contract.js';
import { DEFAULT_INTERRUPTED_NOTICE, OwnerMessageLedger } from './telegram-message-ledger.js';
import { splitForDiscord } from './message-splitter.js';
import {
  OWNER_FILE_MAX_UPLOAD_BYTES,
  openWorkspaceFile,
  workspaceFileIdentity,
} from '../api/file-delivery.js';
import type { OwnerFileDeliveryResult } from '../api/file-delivery.js';
import { saveResponseBody } from '../connectors/framework/attachment-io.js';
import { safeFileName } from '../api/attachment-actions.js';

export interface DiscordGatewayOptions {
  token: string;
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

/** Owner-only Discord transport. It accepts messages into the shared owner turn contract. */
export class DiscordGateway extends BaseGateway {
  readonly source = 'discord' as const;
  private readonly client: Client;
  private readonly ledger: OwnerMessageLedger;
  private readonly log: (line: string) => void;
  private readonly interruptedNotice: string;
  private readonly activeInputs = new Set<string>();
  private readonly deliveryTails = new Map<string, Promise<void>>();

  constructor(private readonly options: DiscordGatewayOptions) {
    super({ intake: options.intake });
    this.log = options.log ?? console.log;
    this.interruptedNotice = options.interruptedNotice ?? DEFAULT_INTERRUPTED_NOTICE;
    this.ledger =
      options.messageLedger ?? new OwnerMessageLedger(options.messageLedgerPath, { log: this.log });
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.accept(message).catch((error: unknown) =>
        this.emitEvent({
          type: 'error',
          source: this.source,
          timestamp: new Date(),
          error: error instanceof Error ? error : new Error(String(error)),
        })
      );
    });
    this.client.on('error', (error) => this.log(`discord client error=${error.message}`));
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (!this.options.config.allowedChannels.length || !this.options.config.ownerUserIds.length)
      throw new Error('discord owner allowlist is not configured');
    if (!this.options.token.trim()) throw new Error('MAMA_DISCORD_TOKEN is required');
    await this.client.login(this.options.token);
    this.connected = true;
    this.emitEvent({ type: 'connected', source: this.source, timestamp: new Date() });
    await this.recoverPendingResponses();
  }

  async stop(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.destroy();
    this.emitEvent({ type: 'disconnected', source: this.source, timestamp: new Date() });
  }

  answered(sourceRef: string): boolean {
    return this.ledger.get(sourceRef)?.state === 'delivered';
  }
  async recoverPendingResponses(): Promise<void> {
    for (const entry of this.ledger.listUndelivered()) {
      try {
        const channel = entry.deliveryTarget?.startsWith('discord:')
          ? entry.deliveryTarget.slice('discord:'.length)
          : '';
        const source = entry.key.startsWith('discord:');
        const outbound = entry.key.startsWith('outbound:') || entry.key.startsWith('file:');
        if (
          (!source && !outbound) ||
          !channel ||
          !this.options.config.allowedChannels.includes(channel)
        )
          continue;
        if (entry.deliveryUncertain) {
          this.log(`discord delivery requires reconciliation key=${entry.key}`);
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
          `discord recovery failed key=${entry.key} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  async deliverResponse(sourceRef: string, response: string): Promise<void> {
    const channelId = sourceRefChannel(sourceRef, 'discord');
    this.requireAllowed(channelId);
    const entry = this.ledger.get(sourceRef);
    if (!entry) throw new Error(`Discord response has no accepted message ${sourceRef}`);
    if (entry.deliveryTarget !== `discord:${channelId}`)
      throw new Error('Discord response destination conflicts with its accepted message');
    if (entry.state === 'delivered') return;
    // Confirmed chunks must continue with the same durable response.
    if (entry.state === 'ready' && entry.response !== response)
      throw new Error('Ready reply conflicts with its durable ledger entry');
    if (entry.state === 'processing') this.ledger.markReady(sourceRef, response);
    await this.runInDestination(channelId, () => this.sendChunks(channelId, sourceRef, response));
  }

  async sendMessage(channelId: string, text: string, idempotencyKey?: string): Promise<void> {
    this.requireConnected();
    this.requireAllowed(channelId);
    const key = `outbound:${createHash('sha256')
      .update(`text\0${idempotencyKey ?? `${channelId}:${text}`}`)
      .digest('hex')}`;
    const claim = this.ledger.claim(key, {
      deliveryTarget: `discord:${channelId}`,
      payloadIdentity: createHash('sha256').update(text).digest('hex'),
      keepDeliveredOnPayloadChange: true,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (!claim.claimed) {
      if (claim.entry.state === 'delivered') return;
      throw new Error('Discord message delivery is already in progress or uncertain');
    }
    this.ledger.markReady(key, text);
    await this.runInDestination(channelId, () => this.sendChunks(channelId, key, text));
  }

  async sendToOwner(text: string, idempotencyKey: string): Promise<void> {
    const channel = this.options.config.ownerChannelId;
    if (!channel) throw new Error('discord.owner_channel_id is required');
    await this.sendMessage(channel, text, idempotencyKey);
  }

  async sendFile(
    path: string,
    caption: string | undefined,
    operationId: string
  ): Promise<OwnerFileDeliveryResult> {
    this.requireConnected();
    if (!operationId.trim()) throw new Error('Discord file operation id is required');
    const channel = this.options.config.ownerChannelId;
    if (!channel) throw new Error('discord.owner_channel_id is required');
    this.requireAllowed(channel);
    if (!this.options.filesRoot) throw new Error('Discord workspace files root is not configured');
    const file = openWorkspaceFile(this.options.filesRoot, path, OWNER_FILE_MAX_UPLOAD_BYTES);
    try {
      const identity = workspaceFileIdentity(file.fd, caption);
      const key = `file:${operationId}`;
      const claim = this.ledger.claim(key, {
        deliveryTarget: `discord:${channel}`,
        payloadIdentity: identity,
        idempotencyKey: operationId,
      });
      if (!claim.claimed) {
        if (claim.entry.state === 'delivered')
          return { sentAs: file.sentAs, size: file.size, idempotent: true };
        throw new Error('Discord file delivery is already in progress or uncertain');
      }
      const target = await this.client.channels.fetch(channel);
      if (!target?.isSendable()) throw new Error('Discord target channel cannot receive messages');
      const sent = await this.runInDestination<
        import('discord.js').Message<false> | import('discord.js').Message<true>
      >(channel, () =>
        target.send({
          content: caption,
          files: [new AttachmentBuilder(readFileSync(file.fd), { name: basename(file.path) })],
        })
      );
      this.ledger.markDelivered(key);
      return { messageId: sent.id, sentAs: file.sentAs, size: file.size };
    } catch (error) {
      if (this.ledger.get(`file:${operationId}`)?.state === 'processing')
        this.ledger.markFailed(`file:${operationId}`);
      throw error;
    } finally {
      closeSync(file.fd);
    }
  }

  private async accept(message: import('discord.js').Message): Promise<void> {
    const channel = message.channelId;
    const user = message.author.id;
    if (
      message.author.bot ||
      !this.options.config.allowedChannels.includes(channel) ||
      !this.options.config.ownerUserIds.includes(user)
    ) {
      this.log(
        `discord message dropped reason=non_owner channel_hash=${hash('channel', channel)} sender_hash=${hash('sender', user)}`
      );
      return;
    }
    const ref = `discord:${channel}:${message.id}`;
    if (this.activeInputs.has(ref)) return;
    const existing = this.ledger.get(ref);
    if (existing) {
      if (existing.state === 'ready') await this.deliverResponse(ref, existing.response ?? '');
      return;
    }
    if (!message.content.trim() && !message.attachments.size) return;
    const identity = createHash('sha256')
      .update(
        `${message.content}\0${[...message.attachments.values()]
          .map((item) => item.id)
          .sort()
          .join(',')}`
      )
      .digest('hex');
    this.ledger.claim(ref, { deliveryTarget: `discord:${channel}`, payloadIdentity: identity });
    this.activeInputs.add(ref);
    try {
      const attachments = await Promise.all(
        [...message.attachments.values()].map(async (attachment) => {
          let name = attachment.name || attachment.id;
          try {
            name = safeFileName(name);
            if (!this.options.downloadsDir)
              throw new Error('Attachment downloads directory is not configured');
            const response = await fetch(attachment.url, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok)
              throw new Error(`Discord attachment download failed (HTTP ${response.status})`);
            const path = join(
              this.options.downloadsDir,
              'discord',
              `${message.id}_${attachment.id}_${name}`
            );
            const size = await saveResponseBody(response, path);
            return {
              name,
              path,
              size,
              ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
            };
          } catch (error) {
            return { name, error: error instanceof Error ? error.message : String(error) };
          }
        })
      );
      const input: OwnerMessageInput = {
        id: ref,
        channelKey: channel,
        occurredAt: message.createdTimestamp,
        text:
          message.content.trim() || attachments.map((file) => `[file: ${file.name}]`).join('\n'),
        ...(attachments.length ? { payload: { attachments } as unknown as JsonValue } : {}),
      };
      this.intake.acceptOwnerMessage(input);
      this.emitEvent({
        type: 'message_received',
        source: this.source,
        timestamp: new Date(message.createdTimestamp),
        data: { sourceMessageRef: ref },
      });
    } finally {
      this.activeInputs.delete(ref);
    }
  }

  private async sendChunks(channelId: string, key: string, text: string): Promise<void> {
    const entry = this.ledger.get(key)!;
    // Another response call may have completed while this batch waited in the destination queue.
    if (entry.state === 'delivered') return;
    if (entry.deliveryUncertain) throw new Error('Discord response delivery is uncertain');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error('Discord target channel cannot receive messages');
    const chunks = splitForDiscord(text);
    for (let i = entry.nextChunkIndex ?? 0; i < chunks.length; i++) {
      this.ledger.markDeliveryProgress(key, i, true);
      try {
        const sent = await channel.send(chunks[i]!);
        this.ledger.markDeliveryProgress(key, i + 1, false, sent.id);
      } catch (error) {
        this.ledger.markDeliveryProgress(key, i, true);
        throw error;
      }
    }
    // Outbound reports and file deliveries have no owner message to answer.
    if (key.startsWith('discord:')) {
      // Recovery must retain whether the host or the agent produced the text.
      if (entry.responseAuthor === undefined) throw new Error('Discord ready reply has no author');
      this.intake.recordOwnerReply({
        messageRef: key,
        text: chunks.join('\n'),
        occurredAt: this.ledger.get(key)!.updatedAt,
        author: entry.responseAuthor,
        deliveryVerified: true,
      });
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
      throw new Error('Discord destination is not allowlisted');
  }
  private requireConnected(): void {
    if (!this.connected) throw new Error('Discord gateway not connected');
  }
}
function hash(kind: string, value: string): string {
  return createHash('sha256').update(`${kind}\0${value}`).digest('hex');
}
function sourceRefChannel(value: string, source: string): string {
  const prefix = `${source}:`;
  if (!value.startsWith(prefix)) throw new Error(`${source} source message reference is invalid`);
  const parts = value.split(':');
  if (parts.length !== 3) throw new Error(`${source} source message reference is invalid`);
  return parts[1]!;
}
