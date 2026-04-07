/**
 * TelegramConnector — polls Telegram channels via native fetch using Bot API getUpdates.
 * Tracks offset state for sequential polling.
 */

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  date: number;
  text?: string;
  chat: {
    id: number;
    type: string;
    title?: string;
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

export class TelegramConnector implements IConnector {
  readonly name = 'telegram';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private token: string | null = null;
  private readonly baseUrl = 'https://api.telegram.org';
  private offset: number = 0;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const token =
      this.config.auth.token ?? process.env[this.config.auth.tokenName ?? 'TELEGRAM_BOT_TOKEN'];
    if (!token) {
      throw new Error('Telegram bot token not found. Set TELEGRAM_BOT_TOKEN environment variable.');
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
        tokenName: 'TELEGRAM_BOT_TOKEN',
        description:
          'Telegram Bot token from @BotFather. Create a bot with /newbot and copy the token.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.token) return false;
      const res = await fetch(`${this.baseUrl}/bot${this.token}/getMe`);
      if (!res.ok) return false;
      const data = (await res.json()) as { ok: boolean };
      return data.ok === true;
    } catch {
      return false;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.token) throw new Error('TelegramConnector not initialized');

    const items: NormalizedItem[] = [];
    let hadError = false;
    const sinceEpoch = Math.floor(since.getTime() / 1000);

    try {
      const url = `${this.baseUrl}/bot${this.token}/getUpdates?offset=${this.offset}&limit=100&timeout=0`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        hadError = true;
        this.lastError = `getUpdates HTTP ${res.status}`;
        this.lastPollTime = new Date();
        this.lastPollCount = 0;
        return items;
      }

      const data = (await res.json()) as TelegramGetUpdatesResponse;

      if (!data.ok) {
        hadError = true;
        this.lastError = 'Telegram API returned ok=false';
        this.lastPollTime = new Date();
        this.lastPollCount = 0;
        return items;
      }

      for (const update of data.result) {
        // Advance offset so we don't re-fetch this update
        if (update.update_id >= this.offset) {
          this.offset = update.update_id + 1;
        }

        const msg = update.message;
        if (!msg) continue;
        if (!msg.text) continue;

        // Filter by date > since
        if (msg.date <= sinceEpoch) continue;

        const chatId = String(msg.chat.id);
        const author = msg.from?.first_name ?? 'unknown';

        items.push({
          source: 'telegram',
          sourceId: `${chatId}:${msg.message_id}`,
          channel: msg.chat.title ?? chatId,
          author,
          content: msg.text,
          timestamp: new Date(msg.date * 1000),
          type: 'message',
          metadata: {
            chatId,
            messageId: msg.message_id,
            updateId: update.update_id,
          },
        });
      }
    } catch (err) {
      hadError = true;
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
