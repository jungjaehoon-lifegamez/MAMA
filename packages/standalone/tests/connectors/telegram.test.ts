import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramConnector } from '../../src/connectors/telegram/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      '-1001234567890': { role: 'hub', name: 'project-chat' },
      '-1009999999999': { role: 'ignore', name: 'noise' },
    },
    auth: {
      type: 'token',
      tokenName: 'TELEGRAM_BOT_TOKEN',
      token: 'test-telegram-token',
    },
    ...overrides,
  };
}

function makeUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 100001,
    message: {
      message_id: 42,
      from: { id: 111, first_name: 'Alice', username: 'alice' },
      date: 1700000001,
      text: 'Hello from Telegram',
      chat: { id: -1001234567890, type: 'supergroup', title: 'Project Chat' },
    },
    ...overrides,
  };
}

function makeGetUpdatesResponse(updates: unknown[]) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ ok: true, result: updates }),
  };
}

describe('TelegramConnector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('name and type', () => {
    it('has name "telegram"', () => {
      const connector = new TelegramConnector(makeConfig());
      expect(connector.name).toBe('telegram');
    });

    it('has type "api"', () => {
      const connector = new TelegramConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with TELEGRAM_BOT_TOKEN', () => {
      const connector = new TelegramConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('TELEGRAM_BOT_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes successfully with a token', async () => {
      const connector = new TelegramConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = new TelegramConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'TELEGRAM_BOT_TOKEN' } })
      );
      const originalEnv = process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_BOT_TOKEN'];
      await expect(connector.init()).rejects.toThrow(/token/i);
      if (originalEnv !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = originalEnv;
    });
  });

  describe('authenticate', () => {
    it('returns true when getMe responds with ok=true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true, result: { id: 1 } }),
        })
      );
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when fetch returns ok=false', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when not initialized', async () => {
      const connector = new TelegramConnector(makeConfig());
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when no updates', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([])));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('filters messages by date > since', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z'); // epoch 1704067200
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeGetUpdatesResponse([
            makeUpdate({
              update_id: 1,
              message: { ...makeUpdate().message, message_id: 1, date: 1704067199 },
            }),
            makeUpdate({
              update_id: 2,
              message: { ...makeUpdate().message, message_id: 2, date: 1704067201 },
            }),
          ])
        )
      );
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(since);
      expect(items).toHaveLength(1);
      expect(items[0]?.timestamp.getTime()).toBe(1704067201 * 1000);
    });

    it('sets sourceId as "chatId:messageId"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('-1001234567890:42');
    });

    it('sets source to "telegram"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('telegram');
    });

    it('sets author from first_name', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('Alice');
    });

    it('sets type to "message"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('message');
    });

    it('skips updates without message', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeGetUpdatesResponse([{ update_id: 200, edited_message: { text: 'edited' } }])
          )
      );
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('skips messages without text', async () => {
      const update = makeUpdate();
      // Remove text from the message
      const msgWithoutText = { ...update.message };
      delete (msgWithoutText as Record<string, unknown>)['text'];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeGetUpdatesResponse([{ ...update, message: msgWithoutText }]))
      );
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('advances offset after poll', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeGetUpdatesResponse([makeUpdate({ update_id: 999 })]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      // Second poll should use offset=1000
      await connector.poll(new Date(0));
      const secondCallUrl = String(mockFetch.mock.calls[1]?.[0]);
      expect(secondCallUrl).toContain('offset=1000');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([])));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime after poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([])));
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      const before = new Date();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('dispose', () => {
    it('clears token so authenticate returns false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true }),
        })
      );
      const connector = new TelegramConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });
  });
});
