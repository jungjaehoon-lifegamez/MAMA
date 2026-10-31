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
import { readConnectorState, writeConnectorState } from '../framework/connector-state.js';

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
  private pendingOffset: number | null = null;
  private pollCommitDeferred = false;
  private stateFilePath: string;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig, stateFilePath: string) {
    // A setting, checked when the source is built, before it runs (see NotionConnector).
    if (config.auth.tokenName !== 'MAMA_TELEGRAM_SOURCE_TOKEN') {
      throw new Error('Telegram source auth.tokenName must be MAMA_TELEGRAM_SOURCE_TOKEN');
    }
    this.config = config;
    if (!stateFilePath.trim()) throw new Error('Telegram state file path is required');
    this.stateFilePath = stateFilePath;
  }

  async init(): Promise<void> {
    const token = process.env[this.config.auth.tokenName!];
    if (!token) {
      throw new Error(
        'Telegram source bot token not found. Run mama secret set MAMA_TELEGRAM_SOURCE_TOKEN.'
      );
    }
    this.token = token;
    this.loadState();
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
        tokenName: 'MAMA_TELEGRAM_SOURCE_TOKEN',
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

  async poll(_since: Date): Promise<NormalizedItem[]> {
    if (!this.token) throw new Error('TelegramConnector not initialized');
    if (this.pendingOffset !== null) throw new Error('Telegram poll handoff is already active');
    this.pendingOffset = this.offset;
    const configuredChats = new Set(
      Object.entries(this.config.channels)
        .filter(([, channel]) => channel.role !== 'ignore')
        .map(([chatId]) => chatId)
    );
    if (configuredChats.size === 0) {
      this.abortPollHandoff();
      throw new Error('Telegram requires explicitly configured source chat identifiers');
    }
    const items: NormalizedItem[] = [];
    try {
      let nextOffset = this.pendingOffset;
      if (nextOffset === null) throw new Error('Telegram poll offset is unavailable');
      for (;;) {
        const pageOffset = nextOffset;
        const url = new URL(`${this.baseUrl}/bot${this.token}/getUpdates`);
        url.searchParams.set('offset', String(nextOffset));
        url.searchParams.set('limit', '100');
        url.searchParams.set('timeout', '0');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let res: Response;
        try {
          res = await fetch(url.toString(), { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
        const data = (await res.json()) as TelegramGetUpdatesResponse;
        if (!data.ok) throw new Error('Telegram API returned ok=false');
        for (const update of data.result) {
          if (update.update_id < nextOffset) continue;
          nextOffset = Math.max(nextOffset, update.update_id + 1);
          const msg = update.message;
          if (!msg?.text) continue;
          const chatId = String(msg.chat.id);
          if (!configuredChats.has(chatId)) continue;
          items.push({
            source: 'telegram',
            sourceId: `${chatId}:${msg.message_id}`,
            channel: chatId,
            author: msg.from?.first_name ?? 'unknown',
            content: msg.text,
            timestamp: new Date(msg.date * 1000),
            type: 'message',
            metadata: { chatId, messageId: msg.message_id, updateId: update.update_id },
          });
        }
        if (data.result.length < 100) break;
        if (nextOffset === pageOffset)
          throw new Error('getUpdates full page did not advance its update cursor');
      }
      this.pendingOffset = nextOffset;
      items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      this.lastError = undefined;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      if (!this.pollCommitDeferred) this.commitPoll();
      return items;
    } catch (error) {
      this.lastError = `Telegram poll failed while reading update pages; last error: ${error instanceof Error ? error.message : String(error)}`;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      if (!this.pollCommitDeferred) this.abortPollHandoff();
      throw new Error(this.lastError, { cause: error });
    }
  }

  private loadState(): void {
    const state = readConnectorState(this.stateFilePath, (value): number => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram connector state must contain an object');
      }
      const offset = (value as Record<string, unknown>).offset;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
        throw new Error('Telegram connector state offset must be a nonnegative safe integer');
      }
      return offset as number;
    });
    this.offset = state ?? 0;
  }

  commitPoll(): void {
    if (this.pendingOffset === null)
      throw new Error('Telegram poll state is unavailable to commit');
    writeConnectorState(this.stateFilePath, { offset: this.pendingOffset });
    this.offset = this.pendingOffset;
    this.pendingOffset = null;
    this.pollCommitDeferred = false;
  }

  beginPollHandoff(): void {
    if (this.pollCommitDeferred || this.pendingOffset !== null) {
      throw new Error('Telegram poll handoff is already active');
    }
    this.pollCommitDeferred = true;
  }

  abortPollHandoff(): void {
    this.pendingOffset = null;
    this.pollCommitDeferred = false;
  }
}
