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

export class DiscordConnector implements IConnector {
  readonly name = 'discord';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private token: string | null = null;
  private readonly baseUrl = 'https://discord.com/api/v10';
  private lastMessageIdPerChannel = new Map<string, string>();
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const token =
      this.config.auth.token ?? process.env[this.config.auth.tokenName ?? 'DISCORD_BOT_TOKEN'];
    if (!token) {
      throw new Error('Discord bot token not found. Set DISCORD_BOT_TOKEN environment variable.');
    }
    this.token = token;
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
        tokenName: 'DISCORD_BOT_TOKEN',
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

    const items: NormalizedItem[] = [];
    let hadError = false;

    for (const [channelId, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;

      try {
        let afterId = this.lastMessageIdPerChannel.get(channelId);
        let hasMore = true;
        while (hasMore) {
          const url = new URL(`${this.baseUrl}/channels/${channelId}/messages`);
          url.searchParams.set('limit', '100');
          if (afterId) url.searchParams.set('after', afterId);

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
            hadError = true;
            this.lastError = `Channel ${channelId}: HTTP ${res.status}`;
            break;
          }

          const messages = (await res.json()) as DiscordMessage[];

          // Discord returns newest-first; reverse to get ascending order
          const sorted = [...messages].reverse();

          for (const msg of sorted) {
            // Skip bot messages
            if (msg.author.bot) continue;
            if (!msg.content) continue;

            const timestamp = new Date(msg.timestamp);

            // Filter by since date
            if (timestamp <= since) continue;

            // Track the newest message id for next poll
            const current = this.lastMessageIdPerChannel.get(channelId);
            if (!current || msg.id > current) {
              this.lastMessageIdPerChannel.set(channelId, msg.id);
            }

            items.push({
              source: 'discord',
              sourceId: `${channelId}:${msg.id}`,
              channel: channelCfg.name ?? channelId,
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

          hasMore = messages.length === 100;
          if (sorted.length > 0) {
            afterId = sorted[sorted.length - 1].id;
          }
        }
      } catch (err) {
        hadError = true;
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
