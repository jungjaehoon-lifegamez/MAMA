import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SlackConnector } from '../../src/connectors/slack/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

// Mock @slack/web-api
vi.mock('@slack/web-api', () => {
  return {
    WebClient: vi.fn().mockImplementation(() => mockWebClient),
  };
});

const mockWebClient = {
  auth: {
    test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U123' }),
  },
  conversations: {
    history: vi.fn(),
  },
  users: {
    info: vi.fn(),
  },
};

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      C001: { role: 'hub', name: 'general' },
      C002: { role: 'spoke', name: 'dev' },
      C003: { role: 'ignore', name: 'noise' },
    },
    auth: {
      type: 'token',
      tokenName: 'SLACK_BOT_TOKEN',
      token: 'xoxb-test-token',
    },
    ...overrides,
  };
}

describe('SlackConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebClient.conversations.history.mockResolvedValue({ messages: [] });
    mockWebClient.users.info.mockResolvedValue({
      user: { real_name: 'Alice', name: 'alice' },
    });
  });

  describe('name and type', () => {
    it('has name "slack"', () => {
      const connector = new SlackConnector(makeConfig());
      expect(connector.name).toBe('slack');
    });

    it('has type "api"', () => {
      const connector = new SlackConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with SLACK_BOT_TOKEN', () => {
      const connector = new SlackConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('SLACK_BOT_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes successfully with a token', async () => {
      const connector = new SlackConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = new SlackConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'SLACK_BOT_TOKEN' } })
      );
      // Ensure env var is not set
      const originalEnv = process.env['SLACK_BOT_TOKEN'];
      delete process.env['SLACK_BOT_TOKEN'];
      await expect(connector.init()).rejects.toThrow(/token/i);
      if (originalEnv !== undefined) process.env['SLACK_BOT_TOKEN'] = originalEnv;
    });
  });

  describe('authenticate', () => {
    it('returns true when auth.test succeeds', async () => {
      const connector = new SlackConnector(makeConfig());
      await connector.init();
      const result = await connector.authenticate();
      expect(result).toBe(true);
    });

    it('returns false when not initialized', async () => {
      const connector = new SlackConnector(makeConfig());
      const result = await connector.authenticate();
      expect(result).toBe(false);
    });

    it('returns false when auth.test throws', async () => {
      mockWebClient.auth.test.mockRejectedValueOnce(new Error('invalid_auth'));
      const connector = new SlackConnector(makeConfig());
      await connector.init();
      const result = await connector.authenticate();
      expect(result).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when no messages', async () => {
      const connector = new SlackConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('skips channels with role "ignore"', async () => {
      const connector = new SlackConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));

      // conversations.history should be called for C001 and C002, not C003
      const calls = mockWebClient.conversations.history.mock.calls.map(
        (c: unknown[]) => (c[0] as { channel: string }).channel
      );
      expect(calls).toContain('C001');
      expect(calls).toContain('C002');
      expect(calls).not.toContain('C003');
    });

    it('skips bot messages', async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        messages: [
          { ts: '1700000001.000', user: 'U123', text: 'hello', bot_id: 'B001' },
          { ts: '1700000002.000', user: 'U456', text: 'world' },
        ],
      });
      const connector = new SlackConnector(
        makeConfig({ channels: { C001: { role: 'hub', name: 'general' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('world');
    });

    it('resolves user IDs to names', async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: '1700000001.000', user: 'U999', text: 'hi there' }],
      });
      mockWebClient.users.info.mockResolvedValueOnce({
        user: { real_name: 'Bob Smith', name: 'bob' },
      });
      const connector = new SlackConnector(
        makeConfig({ channels: { C001: { role: 'hub', name: 'general' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('Bob Smith');
    });

    it('caches user info to avoid repeated API calls', async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        messages: [
          { ts: '1700000001.000', user: 'U999', text: 'msg1' },
          { ts: '1700000002.000', user: 'U999', text: 'msg2' },
        ],
      });
      mockWebClient.users.info.mockResolvedValue({
        user: { real_name: 'Bob Smith', name: 'bob' },
      });
      const connector = new SlackConnector(
        makeConfig({ channels: { C001: { role: 'hub', name: 'general' } } })
      );
      await connector.init();
      await connector.poll(new Date(0));
      // Should only call users.info once despite two messages from same user
      expect(mockWebClient.users.info).toHaveBeenCalledTimes(1);
    });

    it('uses channelId as fallback for sourceId', async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: '1700000001.000', user: 'U123', text: 'test' }],
      });
      const connector = new SlackConnector(
        makeConfig({ channels: { C001: { role: 'hub', name: 'general' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('C001:1700000001.000');
    });

    it('sets source to "slack"', async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: '1700000001.000', user: 'U123', text: 'test' }],
      });
      const connector = new SlackConnector(
        makeConfig({ channels: { C001: { role: 'hub', name: 'general' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('slack');
    });

    it('sets type to "message"', async () => {
      mockWebClient.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: '1700000001.000', user: 'U123', text: 'test' }],
      });
      const connector = new SlackConnector(
        makeConfig({ channels: { C001: { role: 'hub', name: 'general' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('message');
    });

    it('sorts results by timestamp ascending', async () => {
      mockWebClient.conversations.history
        .mockResolvedValueOnce({
          messages: [
            { ts: '1700000003.000', user: 'U123', text: 'third' },
            { ts: '1700000001.000', user: 'U123', text: 'first' },
          ],
        })
        .mockResolvedValueOnce({
          messages: [{ ts: '1700000002.000', user: 'U123', text: 'second' }],
        });
      const connector = new SlackConnector(
        makeConfig({
          channels: {
            C001: { role: 'hub', name: 'general' },
            C002: { role: 'spoke', name: 'dev' },
          },
        })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe('first');
      expect(items[1]?.content).toBe('second');
      expect(items[2]?.content).toBe('third');
    });

    it('uses oldest param based on since timestamp', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z');
      const connector = new SlackConnector(
        makeConfig({ channels: { C001: { role: 'hub', name: 'general' } } })
      );
      await connector.init();
      await connector.poll(since);

      const call = mockWebClient.conversations.history.mock.calls[0] as Array<{ oldest: string }>;
      const oldest = parseFloat(call[0]?.oldest ?? '0');
      expect(oldest).toBeCloseTo(since.getTime() / 1000, 0);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      mockWebClient.conversations.history.mockResolvedValue({ messages: [] });
      const connector = new SlackConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.lastPollTime).not.toBeNull();
    });

    it('is unhealthy before init', async () => {
      const connector = new SlackConnector(makeConfig());
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(false);
    });
  });

  describe('dispose', () => {
    it('clears client and user cache', async () => {
      const connector = new SlackConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      // After dispose, authenticate should return false (client is null)
      const result = await connector.authenticate();
      expect(result).toBe(false);
    });
  });
});
