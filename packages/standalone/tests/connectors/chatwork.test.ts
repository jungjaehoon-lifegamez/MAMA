import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      '12345': { role: 'hub', name: 'project-room' },
      '67890': { role: 'spoke', name: 'general-room' },
      '99999': { role: 'ignore', name: 'noise-room' },
    },
    auth: {
      type: 'token',
      tokenName: 'CHATWORK_API_TOKEN',
      token: 'test-chatwork-token',
    },
    ...overrides,
  };
}

function makeChatworkMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: '1001',
    account: {
      account_id: 42,
      name: 'Alice',
      avatar_image_url: 'https://example.com/alice.png',
    },
    body: 'Hello from Chatwork',
    send_time: 1700000001,
    update_time: 1700000001,
    ...overrides,
  };
}

describe('ChatworkConnector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('name and type', () => {
    it('has name "chatwork"', () => {
      const connector = new ChatworkConnector(makeConfig());
      expect(connector.name).toBe('chatwork');
    });

    it('has type "api"', () => {
      const connector = new ChatworkConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with CHATWORK_API_TOKEN', () => {
      const connector = new ChatworkConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('CHATWORK_API_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes successfully with a token', async () => {
      const connector = new ChatworkConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = new ChatworkConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'CHATWORK_API_TOKEN' } })
      );
      const originalEnv = process.env['CHATWORK_API_TOKEN'];
      delete process.env['CHATWORK_API_TOKEN'];
      await expect(connector.init()).rejects.toThrow(/token/i);
      if (originalEnv !== undefined) process.env['CHATWORK_API_TOKEN'] = originalEnv;
    });
  });

  describe('authenticate', () => {
    it('returns true when /me responds with 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when /me responds with non-200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when not initialized', async () => {
      const connector = new ChatworkConnector(makeConfig());
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when no messages', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([]),
        })
      );
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('skips channels with role "ignore"', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([]),
      });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));

      const calledUrls = mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calledUrls.some((u) => u.includes('12345'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('67890'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('99999'))).toBe(false);
    });

    it('filters messages by send_time > since', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z'); // epoch 1704067200
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([
            makeChatworkMessage({ message_id: '1', send_time: 1704067199 }), // before
            makeChatworkMessage({ message_id: '2', send_time: 1704067201 }), // after
          ]),
        })
      );
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();
      const items = await connector.poll(since);
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('12345:2');
    });

    it('sets correct sourceId as "roomId:messageId"', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([makeChatworkMessage({ message_id: '9876' })]),
        })
      );
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('12345:9876');
    });

    it('sets source to "chatwork"', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([makeChatworkMessage()]),
        })
      );
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('chatwork');
    });

    it('sets type to "message"', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([makeChatworkMessage()]),
        })
      );
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('message');
    });

    it('sets author from account.name', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([
            makeChatworkMessage({
              account: { account_id: 1, name: 'Charlie', avatar_image_url: '' },
            }),
          ]),
        })
      );
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('Charlie');
    });

    it('sets content from body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([makeChatworkMessage({ body: 'Important update' })]),
        })
      );
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe('Important update');
    });

    it('uses channel name from config', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([makeChatworkMessage()]),
        })
      );
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'my-project' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.channel).toBe('my-project');
    });

    it('sends X-ChatWorkToken header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([]),
      });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub' } } })
      );
      await connector.init();
      await connector.poll(new Date(0));

      const callHeaders = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(callHeaders?.['X-ChatWorkToken']).toBe('test-chatwork-token');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([]),
        })
      );
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([]),
        })
      );
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      const before = new Date();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('incremental polling (client-side dedup)', () => {
    it('skips already-seen messages on second poll', async () => {
      const msg1 = makeChatworkMessage({
        message_id: '1001',
        body: 'first',
        send_time: 1700000001,
      });
      const msg2 = makeChatworkMessage({
        message_id: '1002',
        body: 'second',
        send_time: 1700000002,
      });

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          // First poll: returns both messages
          .mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue([msg1, msg2]),
          })
          // Second poll: API returns same messages again
          .mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue([msg1, msg2]),
          })
      );

      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();

      const firstPoll = await connector.poll(new Date(0));
      expect(firstPoll).toHaveLength(2);

      const secondPoll = await connector.poll(new Date(0));
      // Second poll should skip already-seen messages (message_id <= lastMessageId)
      expect(secondPoll).toHaveLength(0);
    });

    it('returns only new messages on second poll', async () => {
      const msg1 = makeChatworkMessage({ message_id: '1001', body: 'old', send_time: 1700000001 });
      const msg2 = makeChatworkMessage({ message_id: '1002', body: 'new', send_time: 1700000002 });

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue([msg1]),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue([msg1, msg2]),
          })
      );

      const connector = new ChatworkConnector(
        makeConfig({ channels: { '12345': { role: 'hub', name: 'project' } } })
      );
      await connector.init();

      await connector.poll(new Date(0));
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('new');
    });
  });

  describe('dispose', () => {
    it('clears the token so authenticate returns false', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = new ChatworkConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });
  });
});
