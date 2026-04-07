import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs to prevent state file I/O from interfering with tests
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { TrelloConnector } from '../../src/connectors/trello/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      board1: {
        role: 'truth',
        name: 'project-board',
        boardId: 'board-abc123',
      },
    },
    auth: {
      type: 'token',
      tokenName: 'TRELLO_TOKEN',
      token: 'myApiKey:myToken',
    },
    ...overrides,
  };
}

function makeTrelloList(
  id: string,
  name: string,
  cards: Array<{ id: string; name: string; dateLastActivity?: string }>
) {
  return {
    id,
    name,
    cards: cards.map((c) => ({
      id: c.id,
      name: c.name,
      idMembers: [],
      dateLastActivity: c.dateLastActivity ?? '2024-01-01T00:00:00.000Z',
    })),
  };
}

describe('TrelloConnector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('name and type', () => {
    it('has name "trello"', () => {
      const connector = new TrelloConnector(makeConfig());
      expect(connector.name).toBe('trello');
    });

    it('has type "api"', () => {
      const connector = new TrelloConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with TRELLO_TOKEN', () => {
      const connector = new TrelloConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('TRELLO_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes with a valid apiKey:token', async () => {
      const connector = new TrelloConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = new TrelloConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'TRELLO_TOKEN' } })
      );
      const orig = process.env['TRELLO_TOKEN'];
      delete process.env['TRELLO_TOKEN'];
      await expect(connector.init()).rejects.toThrow(/token/i);
      if (orig !== undefined) process.env['TRELLO_TOKEN'] = orig;
    });

    it('throws when token format is invalid (no colon)', async () => {
      const connector = new TrelloConnector(
        makeConfig({ auth: { type: 'token', token: 'invalidtoken' } })
      );
      await expect(connector.init()).rejects.toThrow(/format/i);
    });
  });

  describe('authenticate', () => {
    it('returns true when /members/me responds with 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when /members/me responds with non-200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when not initialized', async () => {
      const connector = new TrelloConnector(makeConfig());
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('throws when not initialized', async () => {
      const connector = new TrelloConnector(makeConfig());
      await expect(connector.poll(new Date(0))).rejects.toThrow(/not initialized/i);
    });

    it('returns empty array when board has no lists', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('emits kanban_card items for all cards on first poll', async () => {
      const lists = [
        makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }]),
        makeTrelloList('list2', 'Done', [{ id: 'card2', name: 'Task B' }]),
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(2);
      expect(items[0]?.type).toBe('kanban_card');
      expect(items[1]?.type).toBe('kanban_card');
    });

    it('sets source to "trello"', async () => {
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('trello');
    });

    it('sets sourceId as "boardId:cardId:timestamp"', async () => {
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card-xyz', name: 'Task A' }])];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toMatch(/^board-abc123:card-xyz:\d+$/);
    });

    it('formats content as "cardName | listName" for new cards', async () => {
      const lists = [makeTrelloList('list1', 'Backlog', [{ id: 'card1', name: 'Build feature' }])];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe('Build feature | Backlog');
    });

    it('formats content with "(from: prevList)" for moved cards', async () => {
      const listsFirst = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      const listsSecond = [
        makeTrelloList('list2', 'In Progress', [{ id: 'card1', name: 'Task A' }]),
      ];
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(listsFirst) })
        .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(listsSecond) });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0)); // first poll
      const items = await connector.poll(new Date(0)); // second poll
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('Task A | In Progress (from: Todo)');
    });

    it('does not emit cards that have not moved between polls', async () => {
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(lists) })
        .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(lists) });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('sets author to "trello"', async () => {
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('trello');
    });

    it('sets channel from config name', async () => {
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.channel).toBe('project-board');
    });

    it('sets timestamp from dateLastActivity', async () => {
      const activityTime = '2024-06-15T12:00:00.000Z';
      const lists = [
        makeTrelloList('list1', 'Todo', [
          { id: 'card1', name: 'Task A', dateLastActivity: activityTime },
        ]),
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.timestamp.toISOString()).toBe(activityTime);
    });

    it('skips channels without boardId', async () => {
      const config = makeConfig({
        channels: { 'no-board': { role: 'truth', name: 'no-board' } },
      });
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TrelloConnector(config);
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips channels with role "ignore"', async () => {
      const config = makeConfig({
        channels: {
          board1: { role: 'ignore', name: 'ignored', boardId: 'board-abc123' },
        },
      });
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TrelloConnector(config);
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('uses apiKey and token from config auth token', async () => {
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(lists),
      });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const calledUrl = String(mockFetch.mock.calls[0]?.[0]);
      expect(calledUrl).toContain('key=myApiKey');
      expect(calledUrl).toContain('token=myToken');
    });

    it('handles HTTP error from board endpoint gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });
  });

  describe('healthCheck', () => {
    it('reflects lastPollTime and lastPollCount after poll', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollCount).toBe(0);
    });

    it('returns healthy:true after successful poll', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });
  });

  describe('dispose', () => {
    it('clears token so authenticate returns false', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });

    it('clears card states so next poll emits all cards again', async () => {
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      const mockFetch = vi
        .fn()
        .mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) });
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0)); // first poll — card state captured
      await connector.dispose();
      // Re-init since token was cleared
      await connector.init();
      const items = await connector.poll(new Date(0)); // card state cleared → all cards new again
      expect(items).toHaveLength(1);
    });
  });
});
