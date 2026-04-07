/**
 * ChatworkConnector — polls Chatwork rooms via native fetch.
 * No SDK dependency; uses X-ChatWorkToken header for auth.
 */

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface ChatworkMessage {
  message_id: string;
  account: {
    account_id: number;
    name: string;
    avatar_image_url: string;
  };
  body: string;
  send_time: number;
  update_time: number;
}

export class ChatworkConnector implements IConnector {
  readonly name = 'chatwork';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private token: string | null = null;
  private readonly baseUrl = 'https://api.chatwork.com/v2';
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  /**
   * Per-room last seen message ID for incremental polling.
   * NOTE: The Chatwork API has no cursor-based pagination. The `force=0` mode
   * returns messages since the server-tracked read cursor (up to 100 per call).
   * We additionally track the last seen message_id client-side so we can skip
   * already-processed messages on the first poll after restart.
   * Limitation: if a room receives >100 messages between polls, the oldest
   * messages in that batch will be missed — this is a Chatwork API constraint.
   */
  private lastMessageIds: Map<string, string> = new Map();

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const token =
      this.config.auth.token ?? process.env[this.config.auth.tokenName ?? 'CHATWORK_API_TOKEN'];
    if (!token) {
      throw new Error('Chatwork API token not found. Set CHATWORK_API_TOKEN environment variable.');
    }
    this.token = token;
  }

  async dispose(): Promise<void> {
    this.token = null;
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
        tokenName: 'CHATWORK_API_TOKEN',
        description:
          'Chatwork API token from https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.token) return false;
      const res = await fetch(`${this.baseUrl}/me`, {
        headers: { 'X-ChatWorkToken': this.token },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.token) throw new Error('ChatworkConnector not initialized');

    const items: NormalizedItem[] = [];
    let hadError = false;
    const sinceEpoch = Math.floor(since.getTime() / 1000);

    for (const [roomId, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;

      try {
        // Use force=0 to rely on the server-side read cursor rather than
        // force-fetching all messages. This avoids clobbering the server cursor
        // and correctly returns only new messages since the last acknowledged read.
        // Limitation: up to 100 messages per call — busy rooms may drop messages
        // between polls if the interval is too long relative to message volume.
        const lastMsgId = this.lastMessageIds.get(roomId);
        const res = await fetch(`${this.baseUrl}/rooms/${roomId}/messages?force=0`, {
          headers: { 'X-ChatWorkToken': this.token },
        });

        if (!res.ok) {
          hadError = true;
          this.lastError = `Room ${roomId}: HTTP ${res.status}`;
          continue;
        }

        const messages = (await res.json()) as ChatworkMessage[];

        let maxMsgId = lastMsgId ?? '';
        for (const msg of messages) {
          if (msg.send_time <= sinceEpoch) continue;
          // Skip messages we've already processed (client-side guard)
          if (lastMsgId && msg.message_id <= lastMsgId) continue;

          if (msg.message_id > maxMsgId) maxMsgId = msg.message_id;

          items.push({
            source: 'chatwork',
            sourceId: `${roomId}:${msg.message_id}`,
            channel: channelCfg.name ?? roomId,
            author: msg.account.name,
            content: msg.body,
            timestamp: new Date(msg.send_time * 1000),
            type: 'message',
            metadata: {
              roomId,
              messageId: msg.message_id,
              accountId: msg.account.account_id,
            },
          });
        }

        if (maxMsgId) this.lastMessageIds.set(roomId, maxMsgId);
      } catch (err) {
        hadError = true;
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
