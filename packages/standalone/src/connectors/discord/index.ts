/**
 * DiscordConnector — polls Discord channels via native fetch using REST API.
 * Uses Authorization: Bot token header. Tracks lastMessageId per channel.
 */

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { readConnectorState, writeConnectorState } from '../framework/connector-state.js';

interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
}

const MAX_MESSAGE_PAGES_PER_CHANNEL = 20;

export class DiscordConnector implements IConnector {
  readonly name = 'discord';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private token: string | null = null;
  private readonly baseUrl = 'https://discord.com/api/v10';
  private lastMessageIdPerChannel = new Map<string, string>();
  private pendingMessageIds: Map<string, string> | null = null;
  private pollCommitDeferred = false;
  private stateFilePath: string;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig, stateFilePath: string) {
    // A setting, checked when the source is built, before it runs (see NotionConnector).
    if (config.auth.tokenName !== 'MAMA_DISCORD_TOKEN') {
      throw new Error('Discord auth.tokenName must be MAMA_DISCORD_TOKEN');
    }
    this.config = config;
    if (!stateFilePath.trim()) throw new Error('Discord state file path is required');
    this.stateFilePath = stateFilePath;
  }

  async init(): Promise<void> {
    const token = process.env[this.config.auth.tokenName!];
    if (!token) {
      throw new Error('Discord bot token not found. Run mama secret set MAMA_DISCORD_TOKEN.');
    }
    this.token = token;
    this.loadState();
  }

  async dispose(): Promise<void> {
    this.token = null;
    this.lastMessageIdPerChannel.clear();
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.token !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'token',
        tokenName: 'MAMA_DISCORD_TOKEN',
        description:
          'Discord Bot token from the Discord Developer Portal. Add the bot to your server with MESSAGE_CONTENT intent.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.token) return false;
      const res = await fetch(`${this.baseUrl}/users/@me`, {
        headers: { Authorization: `Bot ${this.token}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.token) throw new Error('DiscordConnector not initialized');
    if (this.pendingMessageIds !== null) throw new Error('Discord poll handoff is already active');
    this.pendingMessageIds = new Map(this.lastMessageIdPerChannel);
    const items: NormalizedItem[] = [];
    const channels = Object.entries(this.config.channels).filter(
      ([, channel]) => channel.role !== 'ignore'
    );
    let failedChannels = 0;
    let lastChannelError: string | undefined;
    for (const [channelId] of channels) {
      try {
        const committedMessageId = this.lastMessageIdPerChannel.get(channelId);
        let beforeId: string | undefined;
        let reachedBoundary = false;
        for (let page = 0; page < MAX_MESSAGE_PAGES_PER_CHANNEL; page += 1) {
          const url = new URL(`${this.baseUrl}/channels/${channelId}/messages`);
          url.searchParams.set('limit', '100');
          if (beforeId) url.searchParams.set('before', beforeId);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          let res: Response;
          try {
            res = await fetch(url.toString(), {
              headers: { Authorization: `Bot ${this.token}` },
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }

          if (!res.ok) {
            throw new Error(`channel ${channelId} page ${page + 1} HTTP ${res.status}`);
          }

          const messages = (await res.json()) as DiscordMessage[];

          // Discord returns newest-first; reverse to get ascending order
          const sorted = [...messages].sort((left, right) => {
            const leftId = BigInt(left.id);
            const rightId = BigInt(right.id);
            return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
          });
          const oldestId = sorted[0]?.id;
          const newestId = sorted.at(-1)?.id;
          if (newestId !== undefined) {
            const currentId = this.pendingMessageIds.get(channelId);
            if (currentId === undefined || BigInt(newestId) > BigInt(currentId)) {
              this.pendingMessageIds.set(channelId, newestId);
            }
          }

          for (const msg of sorted) {
            if (committedMessageId && BigInt(msg.id) <= BigInt(committedMessageId)) continue;
            // Skip bot messages
            if (msg.author.bot) continue;
            if (!msg.content) continue;

            const timestamp = new Date(msg.timestamp);

            // Filter by since date
            if (timestamp <= since) continue;

            items.push({
              source: 'discord',
              sourceId: `${channelId}:${msg.id}`,
              channel: channelId,
              author: msg.author.username,
              content: msg.content,
              timestamp,
              type: 'message',
              metadata: {
                channelId,
                messageId: msg.id,
                authorId: msg.author.id,
              },
            });
          }

          if (messages.length < 100 || oldestId === undefined) {
            reachedBoundary = true;
            break;
          }
          if (beforeId === oldestId) {
            throw new Error(
              `channel ${channelId} pagination repeated before cursor at page ${page + 1}`
            );
          }
          if (committedMessageId && BigInt(oldestId) <= BigInt(committedMessageId)) {
            reachedBoundary = true;
            break;
          }
          if (new Date(sorted[0]!.timestamp) <= since) {
            reachedBoundary = true;
            break;
          }
          beforeId = oldestId;
        }
        if (!reachedBoundary) {
          throw new Error(
            `channel ${channelId} page cap (${MAX_MESSAGE_PAGES_PER_CHANNEL}) reached`
          );
        }
      } catch (error) {
        failedChannels += 1;
        lastChannelError = error instanceof Error ? error.message : String(error);
      }
    }

    if (failedChannels > 0) {
      this.lastError = `Discord poll failed for ${failedChannels} of ${channels.length} configured channels; last error: ${lastChannelError}`;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      if (!this.pollCommitDeferred) this.abortPollHandoff();
      throw new Error(this.lastError);
    }
    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    this.lastError = undefined;
    if (!this.pollCommitDeferred) this.commitPoll();
    return items;
  }

  private loadState(): void {
    const state = readConnectorState(this.stateFilePath, (value): Record<string, string> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Discord connector state must contain an object');
      }
      const entries = Object.entries(value);
      if (entries.some(([, id]) => typeof id !== 'string' || id === '')) {
        throw new Error('Discord connector state must contain nonblank message ids');
      }
      return Object.fromEntries(entries) as Record<string, string>;
    });
    if (state !== undefined) this.lastMessageIdPerChannel = new Map(Object.entries(state));
  }

  commitPoll(): void {
    if (this.pendingMessageIds === null)
      throw new Error('Discord poll state is unavailable to commit');
    writeConnectorState(this.stateFilePath, Object.fromEntries(this.pendingMessageIds));
    this.lastMessageIdPerChannel = this.pendingMessageIds;
    this.pendingMessageIds = null;
    this.pollCommitDeferred = false;
  }

  beginPollHandoff(): void {
    if (this.pollCommitDeferred || this.pendingMessageIds !== null) {
      throw new Error('Discord poll handoff is already active');
    }
    this.pollCommitDeferred = true;
  }

  abortPollHandoff(): void {
    this.pendingMessageIds = null;
    this.pollCommitDeferred = false;
  }
}
