import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotionConnector } from '../../src/connectors/notion/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 10,
    channels: {},
    auth: {
      type: 'token',
      tokenName: 'NOTION_TOKEN',
      token: 'test-notion-token',
    },
    ...overrides,
  };
}

function makePage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-abc-123',
    last_edited_time: '2024-01-15T10:00:00.000Z',
    properties: {
      title: {
        title: [{ plain_text: 'My Page Title' }],
      },
    },
    ...overrides,
  };
}

function makeBlockChildrenResponse(blocks: unknown[]) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ results: blocks }),
  };
}

function makeSearchResponse(pages: unknown[]) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ results: pages, has_more: false, next_cursor: null }),
  };
}

function makeParagraphBlock(text: string) {
  return {
    type: 'paragraph',
    paragraph: {
      rich_text: [{ plain_text: text }],
    },
  };
}

describe('NotionConnector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('name and type', () => {
    it('has name "notion"', () => {
      const connector = new NotionConnector(makeConfig());
      expect(connector.name).toBe('notion');
    });

    it('has type "api"', () => {
      const connector = new NotionConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with NOTION_TOKEN', () => {
      const connector = new NotionConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('NOTION_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes successfully with a token', async () => {
      const connector = new NotionConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = new NotionConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'NOTION_TOKEN' } })
      );
      const originalEnv = process.env['NOTION_TOKEN'];
      delete process.env['NOTION_TOKEN'];
      await expect(connector.init()).rejects.toThrow(/token/i);
      if (originalEnv !== undefined) process.env['NOTION_TOKEN'] = originalEnv;
    });
  });

  describe('authenticate', () => {
    it('returns true when /users/me responds with 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when not initialized', async () => {
      const connector = new NotionConnector(makeConfig());
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('sends Authorization: Bearer and Notion-Version headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      await connector.authenticate();
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.['Authorization']).toBe('Bearer test-notion-token');
      expect(headers?.['Notion-Version']).toBe('2022-06-28');
    });
  });

  describe('poll', () => {
    it('returns empty array when no pages returned', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSearchResponse([])));
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('filters pages by last_edited_time > since', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z');
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          makeSearchResponse([
            makePage({ id: 'old-page', last_edited_time: '2023-12-31T23:59:59.000Z' }),
            makePage({ id: 'new-page', last_edited_time: '2024-01-01T00:00:01.000Z' }),
          ])
        )
        // Block children fetch for new-page
        .mockResolvedValueOnce(makeBlockChildrenResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(since);
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('new-page');
    });

    it('sets sourceId to page.id', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeSearchResponse([makePage({ id: 'abc-123' })]))
        .mockResolvedValueOnce(makeBlockChildrenResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('abc-123');
    });

    it('sets source to "notion"', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeSearchResponse([makePage()]))
        .mockResolvedValueOnce(makeBlockChildrenResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('notion');
    });

    it('sets type to "document"', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeSearchResponse([makePage()]))
        .mockResolvedValueOnce(makeBlockChildrenResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('document');
    });

    it('includes title and block text in content', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeSearchResponse([makePage()]))
        .mockResolvedValueOnce(
          makeBlockChildrenResponse([makeParagraphBlock('Some block content')])
        );
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toContain('My Page Title');
      expect(items[0]?.content).toContain('Some block content');
    });

    it('fetches block children with Authorization header', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeSearchResponse([makePage({ id: 'page-xyz' })]))
        .mockResolvedValueOnce(makeBlockChildrenResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      // Second call is block children
      const secondUrl = String(mockFetch.mock.calls[1]?.[0]);
      expect(secondUrl).toContain('blocks/page-xyz/children');
      const headers = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
      expect(headers?.['Authorization']).toBe('Bearer test-notion-token');
    });

    it('uses POST for search with correct filter', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeSearchResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      expect(mockFetch.mock.calls[0]?.[1]?.method).toBe('POST');
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
      expect(body.filter).toEqual({ property: 'object', value: 'page' });
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSearchResponse([])));
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime after poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSearchResponse([])));
      const connector = new NotionConnector(makeConfig());
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
      const connector = new NotionConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });
  });
});
