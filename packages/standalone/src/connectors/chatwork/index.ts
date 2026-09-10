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
   * NOTE: The Chatwork API has no cursor-based pagination. `force=0` returns only
   * messages the SERVER has not yet handed to this token — a read cursor shared by
   * every reader of the token. Measured live 2026-09-10: a second poller on the same
   * token (30 s cadence vs our 5 min) consumed the cursor first and this connector
   * saw ~1 message/day while the rooms carried ~30/day. So we ask for `force=1`
   * (the latest 100 regardless of read state) and dedupe client-side with the
   * `since` timestamp plus this per-room last seen message_id.
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
        // force=1: the latest 100 messages independent of the server-side read cursor,
        // which any other reader of this token would otherwise consume first. New-ness
        // is decided below by `since` and the per-room last seen message_id.
        const lastMsgId = this.lastMessageIds.get(roomId);
        const res = await fetch(`${this.baseUrl}/rooms/${roomId}/messages?force=1`, {
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
