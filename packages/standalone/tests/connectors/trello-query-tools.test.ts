/**
 * Trello live query tools: the truth answer path for current card state.
 * Auth via the connector contract (config.auth.token ?? env[tokenName],
 * "apiKey:token"); loud no-fallback errors; read-only API usage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTrelloQueryAuth,
  searchTrelloCards,
  getTrelloCard,
  getTrelloKanban,
  clearTrelloSnapshotCache,
} from '../../src/connectors/trello/query-tools.js';

let dir: string;
let configPath: string;

function writeConfig(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      trello: {
        enabled: true,
        pollIntervalMinutes: 5,
        auth: { type: 'token', token: 'myKey:myTok' },
        channels: {
          b1: { role: 'truth', name: 'Board One', boardId: 'b1' },
          b2: { role: 'ignore', name: 'Ignored', boardId: 'b2' },
        },
        ...overrides,
      },
    })
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mama-trello-query-'));
  configPath = join(dir, 'connectors.json');
  clearTrelloSnapshotCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('resolveTrelloQueryAuth', () => {
  it('resolves apiKey/token and enabled board ids from the connector config', () => {
    writeConfig();
    const auth = resolveTrelloQueryAuth({ configPath });
    expect(auth.apiKey).toBe('myKey');
    expect(auth.token).toBe('myTok');
    expect([...auth.boardNames.keys()]).toEqual(['b1']); // ignore-role board excluded
  });

  it('falls back to env[tokenName] and fails loudly when nothing is set', () => {
    writeConfig({ auth: { type: 'token', tokenName: 'MY_TRELLO' } });
    const auth = resolveTrelloQueryAuth({ configPath, env: { MY_TRELLO: 'k:t' } });
    expect(auth.apiKey).toBe('k');
    expect(() => resolveTrelloQueryAuth({ configPath, env: {} })).toThrow(/no credentials/);
  });

  it('rejects a disabled connector and a malformed credential', () => {
    writeConfig({ enabled: false });
    expect(() => resolveTrelloQueryAuth({ configPath })).toThrow(/not enabled/);
    writeConfig({ auth: { type: 'token', token: 'nocolon' } });
    expect(() => resolveTrelloQueryAuth({ configPath })).toThrow(/apiKey:token/);
  });
});

describe('searchTrelloCards', () => {
  it('returns live card summaries with list, labels, and assignee names', async () => {
    writeConfig();
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      expect(u).toContain('/search?');
      expect(u).toContain('idBoards=b1');
      expect(u).toContain('card_list=true');
      return new Response(
        JSON.stringify({
          cards: [
            {
              id: 'c9',
              name: 'ex_100_card',
              due: null,
              dateLastActivity: '2026-07-24T10:00:00.000Z',
              labels: [{ name: '初稿' }, { name: 'artist-a' }],
              members: [{ fullName: 'Alice Kim' }, { username: 'bob' }],
              list: { name: '提出中' },
              board: { id: 'b1', name: 'Board One' },
            },
          ],
        })
      );
    }) as unknown as typeof fetch;

    const cards = await searchTrelloCards({ query: 'ex_100' }, { configPath, fetchFn });
    expect(cards).toEqual([
      {
        cardId: 'c9',
        name: 'ex_100_card',
        board: 'Board One',
        list: '提出中',
        labels: ['初稿', 'artist-a'],
        assignees: ['Alice Kim', 'bob'],
        due: null,
        lastActivity: '2026-07-24T10:00:00.000Z',
      },
    ]);
  });

  it('falls back to a board scan with local substring match when /search misses (CJK)', async () => {
    // Trello's /search tokenizes on word boundaries and misses CJK substrings
    // and underscore compounds - most of the production board vocabulary.
    writeConfig();
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/search?')) return new Response(JSON.stringify({ cards: [] }));
      if (u.includes('/boards/b1/lists')) {
        return new Response(
          JSON.stringify([
            {
              name: '提出中',
              cards: [
                {
                  id: 'c1',
                  name: 'ex_100_エルデリーゼ(メイド)',
                  due: null,
                  dateLastActivity: '2026-07-24T10:00:00.000Z',
                  idMembers: ['m1'],
                  labels: [{ name: '初稿' }],
                },
                {
                  id: 'c2',
                  name: 'unrelated_card',
                  due: null,
                  dateLastActivity: '2026-07-24T10:00:00.000Z',
                  idMembers: [],
                  labels: [],
                },
              ],
            },
          ])
        );
      }
      if (u.includes('/boards/b1/members')) {
        return new Response(JSON.stringify([{ id: 'm1', fullName: 'Alice Kim' }]));
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const cards = await searchTrelloCards({ query: 'エルデリーゼ' }, { configPath, fetchFn });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe('ex_100_エルデリーゼ(メイド)');
    expect(cards[0]?.list).toBe('提出中');
    expect(cards[0]?.labels).toEqual(['初稿']);
    expect(cards[0]?.assignees).toEqual(['Alice Kim']);
    // The ignore-role board (b2) is never scanned.
    const scannedBoards = fetchFn.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/boards/'));
    expect(scannedBoards.every((u) => u.includes('/boards/b1/'))).toBe(true);
  });

  it('refuses an empty query and surfaces HTTP failures loudly', async () => {
    writeConfig();
    await expect(searchTrelloCards({ query: '  ' }, { configPath })).rejects.toThrow(/non-empty/);
    const fetchFn = vi.fn(
      async () => new Response('x', { status: 401 })
    ) as unknown as typeof fetch;
    await expect(searchTrelloCards({ query: 'q' }, { configPath, fetchFn })).rejects.toThrow(
      /HTTP 401/
    );
  });
});

describe('getTrelloKanban + snapshot cache', () => {
  const boardLists = [
    {
      id: 'l1',
      name: '進行',
      cards: [
        {
          id: 'c1',
          name: 'ex_100_card',
          due: null,
          dateLastActivity: '2026-07-24T10:00:00.000Z',
          idMembers: ['m1'],
          labels: [{ name: '初稿' }],
        },
      ],
    },
    { id: 'l2', name: 'empty-list', cards: [] },
  ];
  const roster = [{ id: 'm1', fullName: 'Alice Kim' }];
  const routed = () =>
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/boards/b1/lists')) return new Response(JSON.stringify(boardLists));
      if (u.includes('/boards/b1/members')) return new Response(JSON.stringify(roster));
      if (u.includes('/search?')) return new Response(JSON.stringify({ cards: [] }));
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

  it('one call returns every non-empty column with labels and assignee names', async () => {
    writeConfig();
    const columns = await getTrelloKanban({}, { configPath, fetchFn: routed() });
    expect(columns).toHaveLength(1); // empty list omitted
    expect(columns[0]).toMatchObject({
      board: 'Board One',
      list: '進行',
      count: 1,
    });
    expect(columns[0]?.cards[0]).toMatchObject({
      name: 'ex_100_card',
      labels: ['初稿'],
      assignees: ['Alice Kim'],
    });
  });

  it('repeated reads within the TTL reuse one snapshot (report-turn hot path)', async () => {
    // The 2026-07-24 14:03 report made 15 sequential searches, each
    // re-fetching every board (~10s x 15). One snapshot must serve them all.
    writeConfig();
    const fetchFn = routed();
    await getTrelloKanban({}, { configPath, fetchFn });
    await searchTrelloCards({ query: 'エルデリーゼ' }, { configPath, fetchFn });
    await searchTrelloCards({ query: 'ex_100' }, { configPath, fetchFn });
    const boardFetches = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/boards/b1/lists')).length;
    expect(boardFetches).toBe(1);
  });
});

describe('getTrelloCard', () => {
  it('returns detail with bounded description and checklist completion states', async () => {
    writeConfig();
    const fetchFn = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/cards/c9?');
      return new Response(
        JSON.stringify({
          id: 'c9',
          name: 'ex_100_card',
          due: '2026-08-01T00:00:00.000Z',
          dateLastActivity: '2026-07-24T10:00:00.000Z',
          desc: 'd'.repeat(2000),
          labels: [{ name: '1回修正' }],
          members: [{ fullName: 'Alice Kim' }],
          list: { name: 'FB対応' },
          board: { id: 'b1', name: 'Board One' },
          checklists: [
            {
              name: 'rounds',
              checkItems: [
                { name: '初稿', state: 'complete' },
                { name: '1回修正', state: 'incomplete' },
              ],
            },
          ],
        })
      );
    }) as unknown as typeof fetch;

    const card = await getTrelloCard({ cardId: 'c9' }, { configPath, fetchFn });
    expect(card.list).toBe('FB対応');
    expect(card.labels).toEqual(['1回修正']);
    expect(card.description).toHaveLength(1000);
    expect(card.checklists[0]?.items).toEqual([
      { name: '初稿', complete: true },
      { name: '1回修正', complete: false },
    ]);
  });

  it('rejects a missing or non-alphanumeric cardId before any network call', async () => {
    writeConfig();
    await expect(getTrelloCard({ cardId: '' }, { configPath })).rejects.toThrow(/cardId/);
    await expect(getTrelloCard({ cardId: '../x' }, { configPath })).rejects.toThrow(/cardId/);
  });
});
