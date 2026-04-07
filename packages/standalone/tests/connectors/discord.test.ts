import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DiscordConnector } from '../../src/connectors/discord/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      '111222333444555': { role: 'hub', name: 'project-channel' },
      '999888777666555': { role: 'spoke', name: 'general' },
      '000111222333444': { role: 'ignore', name: 'noise' },
    },
    auth: {
      type: 'token',
      tokenName: 'DISCORD_BOT_TOKEN',
      token: 'test-discord-token',
    },
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: '987654321098765432',
    content: 'Hello from Discord',
    timestamp: '2023-11-14T22:13:21.000Z',
    author: {
      id: '123456789012345678',
      username: 'alice',
      bot: false,
    },
    ...overrides,
  };
}

function makeOkResponse(messages: unknown[]) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(messages),
  };
}

describe('DiscordConnector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('name and type', () => {
    it('has name "discord"', () => {
      const connector = new DiscordConnector(makeConfig());
      expect(connector.name).toBe('discord');
    });

    it('has type "api"', () => {
      const connector = new DiscordConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with DISCORD_BOT_TOKEN', () => {
      const connector = new DiscordConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('DISCORD_BOT_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes successfully with a token', async () => {
      const connector = new DiscordConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = new DiscordConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'DISCORD_BOT_TOKEN' } })
      );
      const originalEnv = process.env['DISCORD_BOT_TOKEN'];
      delete process.env['DISCORD_BOT_TOKEN'];
      await expect(connector.init()).rejects.toThrow(/token/i);
      if (originalEnv !== undefined) process.env['DISCORD_BOT_TOKEN'] = originalEnv;
    });
  });

  describe('authenticate', () => {
    it('returns true when /users/@me responds with 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when not initialized', async () => {
      const connector = new DiscordConnector(makeConfig());
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('sends Authorization: Bot header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      await connector.authenticate();
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.['Authorization']).toBe('Bot test-discord-token');
    });
  });

  describe('poll', () => {
    it('returns empty array when no messages', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([])));
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('skips channels with role "ignore"', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeOkResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));

      const calledUrls = mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calledUrls.some((u) => u.includes('111222333444555'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('999888777666555'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('000111222333444'))).toBe(false);
    });

    it('filters messages by timestamp > since', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z');
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeOkResponse([
              makeMessage({ id: '1', timestamp: '2023-12-31T23:59:59.000Z' }),
              makeMessage({ id: '2', timestamp: '2024-01-01T00:00:01.000Z' }),
            ])
          )
      );
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(since);
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('111222333444555:2');
    });

    it('sets sourceId as "channelId:messageId"', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeOkResponse([makeMessage({ id: '42' })]))
      );
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('111222333444555:42');
    });

    it('sets source to "discord"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([makeMessage()])));
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('discord');
    });

    it('sets author from username', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeOkResponse([makeMessage({ author: { id: '1', username: 'bob', bot: false } })])
          )
      );
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('bob');
    });

    it('sets type to "message"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([makeMessage()])));
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('message');
    });

    it('skips bot messages', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeOkResponse([makeMessage({ author: { id: '1', username: 'mybot', bot: true } })])
          )
      );
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('skips messages without content', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeOkResponse([makeMessage({ content: '' })]))
      );
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('sends Authorization: Bot header', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeOkResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new DiscordConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub' } } })
      );
      await connector.init();
      await connector.poll(new Date(0));
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.['Authorization']).toBe('Bot test-discord-token');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([])));
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime after poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([])));
      const connector = new DiscordConnector(makeConfig());
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
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = new DiscordConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });
  });
});
