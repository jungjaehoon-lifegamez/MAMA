/**
 * SlackConnector — polls Slack channels via the Web API.
 * Uses dynamic import for @slack/web-api to keep it optional at module load time.
 */

import type { WebClient } from '@slack/web-api';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

export class SlackConnector implements IConnector {
  readonly name = 'slack';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private client: WebClient | null = null;
  private userCache = new Map<string, string>();
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const token =
      this.config.auth.token ?? process.env[this.config.auth.tokenName ?? 'SLACK_BOT_TOKEN'];
    if (!token) {
      throw new Error('Slack bot token not found. Set SLACK_BOT_TOKEN environment variable.');
    }
    const { WebClient } = await import('@slack/web-api');
    this.client = new WebClient(token);
  }

  async dispose(): Promise<void> {
    this.client = null;
    this.userCache.clear();
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.client !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'token',
        tokenName: 'SLACK_BOT_TOKEN',
        description: 'Slack Bot OAuth token with channels:history and users:read scopes.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.client) return false;
      await this.client.auth.test();
      return true;
    } catch {
      return false;
    }
  }

  private async resolveUserName(userId: string): Promise<string> {
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }
    if (!this.client) return userId;
    try {
      const result = await this.client.users.info({ user: userId });
      const name: string = result.user?.real_name ?? result.user?.name ?? userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      this.userCache.set(userId, userId);
      return userId;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.client) throw new Error('SlackConnector not initialized');

    const items: NormalizedItem[] = [];
    let hadError = false;

    for (const [channelId, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;

      const sinceTs = (since.getTime() / 1000).toFixed(6);

      try {
        let cursor: string | undefined;
        do {
          const result = await this.client.conversations.history({
            channel: channelId,
            oldest: sinceTs,
            limit: 200,
            cursor,
          });

          const messages = result.messages ?? [];

          for (const msg of messages) {
            // Skip bot messages
            if (msg.bot_id || msg.subtype === 'bot_message') continue;
            // Skip messages without user or text
            if (!msg.user || !msg.text) continue;

            const authorName = await this.resolveUserName(msg.user as string);
            const timestamp = new Date(parseFloat(msg.ts as string) * 1000);

            items.push({
              source: 'slack',
              sourceId: `${channelId}:${msg.ts as string}`,
              channel: channelCfg.name ?? channelId,
              author: authorName,
              content: msg.text as string,
              timestamp,
              type: 'message',
              metadata: {
                channelId,
                ts: msg.ts as string,
                threadTs: msg.thread_ts as string | undefined,
              },
            });
          }

          cursor = result.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch (err) {
        hadError = true;
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // Sort ascending by timestamp
    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
