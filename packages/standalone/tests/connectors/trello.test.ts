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

    it('omits prevListName from metadata on first sight of a card', async () => {
      // Regression: undefined metadata values blow up the canonical raw-ref
      // serializer at poll time ("undefined is not serializable at $.prevListName").
      const lists = [makeTrelloList('list1', 'Todo', [{ id: 'card1', name: 'Task A' }])];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(lists) })
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect('prevListName' in (items[0]?.metadata ?? {})).toBe(false);
      expect(Object.values(items[0]?.metadata ?? {})).not.toContain(undefined);
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

  describe('labels + assignees enrichment', () => {
    // Owner question this exists for: "who owns this card and which revision
    // round is it in?" Production boards track both ON the card (members + a
    // 初稿/1回修正-style label), so the poller ingests them and treats a
    // label/member change on an unmoved card as a change worth emitting.
    type FakeCard = {
      id: string;
      name: string;
      idMembers?: string[];
      labels?: Array<{ name: string; color: string | null }>;
      dateLastActivity?: string;
    };
    const richLists = (name: string, cards: FakeCard[]) => [
      {
        id: 'l1',
        name,
        cards: cards.map((c) => ({
          idMembers: [],
          labels: [],
          dateLastActivity: '2024-01-01T00:00:00.000Z',
          ...c,
        })),
      },
    ];
    const routedFetch = (
      lists: unknown,
      members: Array<{ id: string; fullName?: string; username?: string }> | 'fail'
    ) =>
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/lists')) return { ok: true, json: async () => lists };
        if (u.includes('/members?')) {
          if (members === 'fail') return { ok: false, status: 500 };
          return { ok: true, json: async () => members };
        }
        return { ok: false, status: 404 };
      });

    it('new cards carry resolved assignee names and labels in content and metadata', async () => {
      const lists = richLists('進行', [
        {
          id: 'c1',
          name: 'ex_100_card',
          idMembers: ['m1', 'm2'],
          labels: [
            { name: '初稿', color: 'sky' },
            { name: 'artist-a', color: 'green' },
          ],
        },
      ]);
      vi.stubGlobal(
        'fetch',
        routedFetch(lists, [
          { id: 'm1', fullName: 'Alice Kim' },
          { id: 'm2', username: 'bob' },
        ])
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe(
        'ex_100_card | 進行 | labels: 初稿, artist-a | assignees: Alice Kim, bob'
      );
      expect(items[0]?.metadata).toMatchObject({
        labels: ['初稿', 'artist-a'],
        memberNames: ['Alice Kim', 'bob'],
        members: ['m1', 'm2'],
      });
    });

    it('a label change on an unmoved card emits with the old -> new transition', async () => {
      const card: FakeCard = {
        id: 'c1',
        name: 'ex_100_card',
        idMembers: ['m1'],
        labels: [{ name: '初稿', color: 'sky' }],
      };
      const roster = [{ id: 'm1', fullName: 'Alice Kim' }];
      vi.stubGlobal('fetch', routedFetch(richLists('進行', [card]), roster));
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0)); // baseline

      vi.stubGlobal(
        'fetch',
        routedFetch(
          richLists('進行', [{ ...card, labels: [{ name: '1回修正', color: 'sky' }] }]),
          roster
        )
      );
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toContain('(labels: 初稿 -> 1回修正)');
      expect(items[0]?.content).toContain('| labels: 1回修正');
      // A pure label change is not a move.
      expect(items[0]?.content).not.toContain('(from:');
    });

    it('member-name resolution failure degrades to raw ids, never drops the poll', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch(
          richLists('進行', [{ id: 'c1', name: 'ex_100_card', idMembers: ['m9'] }]),
          'fail'
        )
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toContain('assignees: m9');
    });

    it('skips the member roster call when no open card has members', async () => {
      const mockFetch = routedFetch(richLists('進行', [{ id: 'c1', name: 'plain_card' }]), []);
      vi.stubGlobal('fetch', mockFetch);
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      expect(mockFetch.mock.calls.map((c) => String(c[0]))).toHaveLength(1);
    });

    it('legacy plain-listName state upgrades silently instead of flooding every card', async () => {
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ lastCardStates: { 'board-abc123': { c1: '進行' } } })
      );
      vi.stubGlobal(
        'fetch',
        routedFetch(
          richLists('進行', [
            {
              id: 'c1',
              name: 'ex_100_card',
              idMembers: ['m1'],
              labels: [{ name: '初稿', color: 'sky' }],
            },
          ]),
          [{ id: 'm1', fullName: 'Alice Kim' }]
        )
      );
      const connector = new TrelloConnector(makeConfig());
      await connector.init();
      // Same list + newly-visible labels/members must NOT emit (the legacy
      // baseline has no label/member knowledge to diff against) ...
      expect(await connector.poll(new Date(0))).toHaveLength(0);
      // ... and the persisted state is upgraded to v2 so future label changes DO emit.
      const written = vi
        .mocked(fs.writeFileSync)
        .mock.calls.map((c) => String(c[1]))
        .find((s) => s.includes('lastCardStates'));
      expect(written).toBeDefined();
      expect(written).toContain('v2:');
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
