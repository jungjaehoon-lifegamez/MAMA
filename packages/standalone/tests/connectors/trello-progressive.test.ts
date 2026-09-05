/**
 * Task C — progressive Trello facades over OFFLINE fixtures (no live calls).
 *
 * Covers: overview without card arrays; a list with >100 cards traversed exactly
 * once past the old ceiling; a failed board that is never an empty-complete list;
 * search beyond the old 20-cap with honest total and coverage; card detail
 * sections reaching description/checklist/item tails; the board allowlist on
 * detail (allowed vs denied vs empty-config); and cursor invalidation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTrelloBoardsOverview,
  getTrelloListCards,
  searchTrelloBoardCards,
  getTrelloCardDetail,
  clearTrelloSnapshotCache,
} from '../../src/connectors/trello/query-tools.js';

let dir: string;
let configPath: string;

function writeConfig(channels: Record<string, unknown>): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      trello: {
        enabled: true,
        pollIntervalMinutes: 5,
        auth: { type: 'token', token: 'myKey:myTok' },
        channels,
      },
    })
  );
}

/** Full trello config with a variable token/enabled, for authorization-change tests. */
function writeAuthConfig(opts: {
  channels: Record<string, unknown>;
  token?: string;
  enabled?: boolean;
}): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      trello: {
        enabled: opts.enabled ?? true,
        pollIntervalMinutes: 5,
        auth: { type: 'token', token: opts.token ?? 'myKey:myTok' },
        channels: opts.channels,
      },
    })
  );
}

const TWO_BOARDS = {
  b1: { role: 'truth', name: 'Board One', boardId: 'b1' },
  b2: { role: 'hub', name: 'Board Two', boardId: 'b2' },
};

/** b1: L1 has 130 open cards (30 also contain "special"), L2 empty. b2 fails to read. */
function routedBoards(): typeof fetch {
  const l1Cards = Array.from({ length: 130 }, (_, i) => ({
    id: `c${i}`,
    name: i < 30 ? `row-special-${i}` : `row-${i}`,
    due: null,
    dateLastActivity: '2026-07-24T10:00:00.000Z',
    idMembers: [],
    labels: [],
  }));
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/boards/b1/lists')) {
      return new Response(
        JSON.stringify([
          { id: 'l1', name: 'L1', cards: l1Cards },
          { id: 'l2', name: 'L2', cards: [] },
        ])
      );
    }
    if (u.includes('/boards/b2/lists')) return new Response('nope', { status: 500 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mama-trello-prog-'));
  configPath = join(dir, 'connectors.json');
  clearTrelloSnapshotCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearTrelloSnapshotCache();
  vi.unstubAllGlobals();
});

describe('Task C: trello overview', () => {
  it('returns boards and lists with counts and coverage, never card arrays', async () => {
    writeConfig(TWO_BOARDS);
    const overview = await getTrelloBoardsOverview({ configPath, fetchFn: routedBoards() });
    expect(JSON.stringify(overview)).not.toContain('cardId');
    const b1 = overview.boards.find((b) => b.boardId === 'b1')!;
    // Overview carries the STABLE listId alongside the display name.
    expect(b1.lists).toContainEqual({ listId: 'l1', list: 'L1', count: 130 });
    // A failed board keeps the whole overview incomplete - absence is not empty.
    expect(overview.boards.find((b) => b.boardId === 'b2')!.status).toBe('failed');
    expect(overview.complete).toBe(false);
    expect(typeof overview.readVersion).toBe('string');
  });
});

describe('Task C: trello cards view', () => {
  it('traverses a >100-card list exactly once past the old ceiling', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = routedBoards();
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let total = -1;
    do {
      const page = await getTrelloListCards(
        { boardId: 'b1', listId: 'l1', cursor },
        { configPath, fetchFn }
      );
      total = page.total;
      pages += 1;
      for (const card of page.cards) {
        seen.add(card.cardId);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(total).toBe(130);
    expect(seen.size).toBe(130);
    expect(pages).toBe(Math.ceil(130 / 25));
  });

  it('rejects a limit outside 1..50 and a scope-mismatched or stale cursor', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = routedBoards();
    await expect(
      getTrelloListCards({ boardId: 'b1', listId: 'l1', limit: 51 }, { configPath, fetchFn })
    ).rejects.toThrow(/1 to 50/);
    const first = await getTrelloListCards(
      { boardId: 'b1', listId: 'l1' },
      { configPath, fetchFn }
    );
    // A cursor from l1 must not resolve against a different list scope.
    await expect(
      getTrelloListCards(
        { boardId: 'b1', listId: 'l2', cursor: first.nextCursor! },
        { configPath, fetchFn }
      )
    ).rejects.toThrow(/different scope|replaced/);
    // Snapshot gone -> the continuation restarts, never pages a different snapshot.
    clearTrelloSnapshotCache();
    await expect(
      getTrelloListCards(
        { boardId: 'b1', listId: 'l1', cursor: first.nextCursor! },
        { configPath, fetchFn }
      )
    ).rejects.toThrow(/no longer cached|restart/);
  });

  it('reports a failed board as coverage.failed, not an empty complete list', async () => {
    writeConfig(TWO_BOARDS);
    const page = await getTrelloListCards(
      { boardId: 'b2', listId: 'whatever' },
      { configPath, fetchFn: routedBoards() }
    );
    expect(page.coverage.status).toBe('failed');
    expect(page.cards).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('reaches TWO same-named lists on one board independently by their distinct listIds', async () => {
    writeConfig({ b1: { role: 'truth', name: 'Board One', boardId: 'b1' } });
    // Two lists share the display name "Todo" but have distinct Trello ids and cards.
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/boards/b1/lists')) {
        return new Response(
          JSON.stringify([
            {
              id: 'listA',
              name: 'Todo',
              cards: Array.from({ length: 3 }, (_, i) => ({
                id: `a${i}`,
                name: `a-${i}`,
                due: null,
                dateLastActivity: '2026-07-24T10:00:00.000Z',
                idMembers: [],
                labels: [],
              })),
            },
            {
              id: 'listB',
              name: 'Todo',
              cards: Array.from({ length: 5 }, (_, i) => ({
                id: `b${i}`,
                name: `b-${i}`,
                due: null,
                dateLastActivity: '2026-07-24T10:00:00.000Z',
                idMembers: [],
                labels: [],
              })),
            },
          ])
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const overview = await getTrelloBoardsOverview({ configPath, fetchFn });
    const b1 = overview.boards.find((b) => b.boardId === 'b1')!;
    // Both same-named lists are present with distinct stable ids and their own counts.
    expect(b1.lists).toEqual([
      { listId: 'listA', list: 'Todo', count: 3 },
      { listId: 'listB', list: 'Todo', count: 5 },
    ]);

    const walk = async (listId: string): Promise<Set<string>> => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await getTrelloListCards(
          { boardId: 'b1', listId, cursor },
          { configPath, fetchFn }
        );
        expect(page.total).toBe(listId === 'listA' ? 3 : 5);
        for (const card of page.cards) {
          seen.add(card.cardId);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return seen;
    };
    const a = await walk('listA');
    const b = await walk('listB');
    expect([...a].sort()).toEqual(['a0', 'a1', 'a2']);
    expect([...b].sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);

    // A listA cursor is bound to listA's scope and cannot page listB.
    const firstA = await getTrelloListCards(
      { boardId: 'b1', listId: 'listA', limit: 1 },
      { configPath, fetchFn }
    );
    await expect(
      getTrelloListCards(
        { boardId: 'b1', listId: 'listB', cursor: firstA.nextCursor! },
        { configPath, fetchFn }
      )
    ).rejects.toThrow(/different scope|replaced/);
  });
});

describe('Task C: trello search', () => {
  it('returns the honest full match total beyond the old 20-cap and pages every match', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = routedBoards();
    const seen = new Set<string>();
    let cursor: string | undefined;
    let total = -1;
    do {
      const page = await searchTrelloBoardCards(
        { query: 'special', cursor },
        { configPath, fetchFn }
      );
      total = page.total;
      // A failed board keeps search incomplete: a missing match is not proven absent.
      expect(page.coverage.complete).toBe(false);
      for (const card of page.cards) {
        seen.add(card.cardId);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(total).toBe(30);
    expect(seen.size).toBe(30);
  });
});

describe('TG-04 AC: Trello authorization is re-bound on every page (P1)', () => {
  // Page 1 caches the snapshot; the config is then mutated, and the cursor
  // continuation must reject BEFORE any cached card field is returned.
  async function firstCardPage(): Promise<string> {
    const fetchFn = routedBoards();
    const first = await getTrelloListCards(
      { boardId: 'b1', listId: 'l1', limit: 1 },
      { configPath, fetchFn }
    );
    expect(first.nextCursor).not.toBeNull();
    return first.nextCursor!;
  }

  it('rejects a cards continuation after the read board leaves the allowlist', async () => {
    writeConfig(TWO_BOARDS);
    const cursor = await firstCardPage();
    // b1 (the board being read) is removed from the configured allowlist.
    writeAuthConfig({ channels: { b2: { role: 'hub', name: 'Board Two', boardId: 'b2' } } });
    await expect(
      getTrelloListCards({ boardId: 'b1', listId: 'l1', cursor }, { configPath })
    ).rejects.toThrow(/authorization changed|not configured\/authorized/);
  });

  it('rejects a cards continuation after another configured board is removed', async () => {
    writeConfig(TWO_BOARDS);
    const cursor = await firstCardPage();
    // b1 is still configured, but the allowlist changed (b2 removed): the whole
    // authorization fingerprint moves, so the cached snapshot is not reused.
    writeAuthConfig({ channels: { b1: { role: 'truth', name: 'Board One', boardId: 'b1' } } });
    await expect(
      getTrelloListCards({ boardId: 'b1', listId: 'l1', cursor }, { configPath })
    ).rejects.toThrow(/authorization changed/);
  });

  it('rejects a cards continuation after the connector is disabled', async () => {
    writeConfig(TWO_BOARDS);
    const cursor = await firstCardPage();
    writeAuthConfig({ channels: TWO_BOARDS, enabled: false });
    await expect(
      getTrelloListCards({ boardId: 'b1', listId: 'l1', cursor }, { configPath })
    ).rejects.toThrow(/not enabled/);
  });

  it('rejects a cards continuation after the token changes', async () => {
    writeConfig(TWO_BOARDS);
    const cursor = await firstCardPage();
    writeAuthConfig({ channels: TWO_BOARDS, token: 'newKey:newTok' });
    await expect(
      getTrelloListCards({ boardId: 'b1', listId: 'l1', cursor }, { configPath })
    ).rejects.toThrow(/authorization changed/);
  });

  it('continues a cards continuation when authorization is unchanged', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = routedBoards();
    const first = await getTrelloListCards(
      { boardId: 'b1', listId: 'l1', limit: 1 },
      { configPath, fetchFn }
    );
    const second = await getTrelloListCards(
      { boardId: 'b1', listId: 'l1', limit: 1, cursor: first.nextCursor! },
      { configPath, fetchFn }
    );
    expect(second.returned).toBe(1);
    expect(second.cards[0]?.cardId).not.toBe(first.cards[0]?.cardId);
  });

  it('rejects a search continuation after the token changes', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = routedBoards();
    const first = await searchTrelloBoardCards(
      { query: 'special', limit: 1 },
      { configPath, fetchFn }
    );
    expect(first.nextCursor).not.toBeNull();
    writeAuthConfig({ channels: TWO_BOARDS, token: 'newKey:newTok' });
    await expect(
      searchTrelloBoardCards({ query: 'special', cursor: first.nextCursor! }, { configPath })
    ).rejects.toThrow(/authorization changed/);
  });
});

describe('Task C: trello card detail sections + allowlist', () => {
  function cardFetch(boardId: string): typeof fetch {
    return vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/cards/c9?');
      return new Response(
        JSON.stringify({
          id: 'c9',
          name: 'ex_100_card',
          due: '2026-08-01T00:00:00.000Z',
          dateLastActivity: '2026-07-24T10:00:00.000Z',
          desc: 'd'.repeat(2500),
          labels: [{ name: '1回修正' }],
          members: [{ fullName: 'Alice Kim' }],
          list: { name: 'FB対応' },
          board: { id: boardId, name: 'Some Board' },
          checklists: Array.from({ length: 12 }, (_, i) => ({
            id: `cl${i}`,
            name: `checklist-${i}`,
            checkItems: Array.from({ length: 40 }, (_, j) => ({
              name: `item-${j}`,
              state: j % 2 === 0 ? 'complete' : 'incomplete',
            })),
          })),
        })
      );
    }) as unknown as typeof fetch;
  }

  it('resolves every checklist header id to its items, including an absent-id checklist', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'c9',
            name: 'x',
            due: null,
            dateLastActivity: '2026-07-24T10:00:00.000Z',
            desc: '',
            labels: [],
            members: [],
            list: { name: 'L' },
            board: { id: 'b1', name: 'B' },
            checklists: [
              {
                id: 'aa11bb22cc33dd44ee55ff66',
                name: 'has-id',
                checkItems: [{ name: 'i0', state: 'complete' }],
              },
              // No raw id: addressed by the shared idx: namespace, still reachable.
              {
                name: 'no-id',
                checkItems: [
                  { name: 'j0', state: 'incomplete' },
                  { name: 'j1', state: 'complete' },
                ],
              },
            ],
          })
        )
    ) as unknown as typeof fetch;

    const headers = (await getTrelloCardDetail(
      { cardId: 'c9', section: 'checklists' },
      { configPath, fetchFn }
    )) as { checklists: Array<{ id: string; itemCount: number }>; readVersion: string };
    // The absent-id checklist gets an idx: key that cannot be confused with a hex id.
    expect(headers.checklists.map((c) => c.id)).toEqual(['aa11bb22cc33dd44ee55ff66', 'idx:1']);
    // EVERY returned header id resolves back to its own items.
    for (const header of headers.checklists) {
      const items = (await getTrelloCardDetail(
        {
          cardId: 'c9',
          section: 'checklist_items',
          checklistId: header.id,
          readVersion: headers.readVersion,
        },
        { configPath, fetchFn }
      )) as { items: unknown[]; total: number };
      expect(items.total).toBe(header.itemCount);
    }
  });

  it('summary reports lengths/counts and description/checklists/items page their tails', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = cardFetch('b1');
    const summary = await getTrelloCardDetail({ cardId: 'c9' }, { configPath, fetchFn });
    expect(summary).toMatchObject({
      section: 'summary',
      descriptionLength: 2500,
      checklistCount: 12,
      itemCount: 12 * 40,
    });

    // Description tail beyond the old 1000 cut is reachable by code-point paging,
    // with the readVersion echoed on every continuation.
    let desc = '';
    let offset: number | null = 0;
    let version: string | undefined;
    while (offset !== null) {
      const page = (await getTrelloCardDetail(
        { cardId: 'c9', section: 'description', offset, limit: 1000, readVersion: version },
        { configPath, fetchFn }
      )) as { content: string; nextOffset: number | null; readVersion: string };
      version = page.readVersion;
      desc += page.content;
      offset = page.nextOffset;
    }
    expect(desc).toHaveLength(2500);

    const cardVersion = (summary as { readVersion: string }).readVersion;

    // Checklists beyond the old 10 are reachable by record paging.
    const cl = (await getTrelloCardDetail(
      { cardId: 'c9', section: 'checklists', offset: 10, limit: 25, readVersion: cardVersion },
      { configPath, fetchFn }
    )) as { checklists: unknown[]; total: number; nextOffset: number | null };
    expect(cl.total).toBe(12);
    expect(cl.checklists).toHaveLength(2);
    expect(cl.nextOffset).toBeNull();

    // Items beyond the old 30 are reachable via checklist_items.
    const items = (await getTrelloCardDetail(
      {
        cardId: 'c9',
        section: 'checklist_items',
        checklistId: 'cl0',
        offset: 30,
        limit: 50,
        readVersion: cardVersion,
      },
      { configPath, fetchFn }
    )) as { items: unknown[]; total: number };
    expect(items.total).toBe(40);
    expect(items.items).toHaveLength(10);
  });

  it('requires checklistId for items and rejects unknown section/checklist', async () => {
    writeConfig(TWO_BOARDS);
    const fetchFn = cardFetch('b1');
    await expect(
      getTrelloCardDetail({ cardId: 'c9', section: 'checklist_items' }, { configPath, fetchFn })
    ).rejects.toThrow(/checklistId/);
    await expect(
      getTrelloCardDetail(
        { cardId: 'c9', section: 'checklist_items', checklistId: 'ghost' },
        { configPath, fetchFn }
      )
    ).rejects.toThrow(/unknown checklistId/);
    await expect(
      getTrelloCardDetail({ cardId: 'c9', section: 'bogus' }, { configPath, fetchFn })
    ).rejects.toThrow(/section must be/);
  });

  it('refuses a card on an unconfigured board generically, leaking no fields', async () => {
    writeConfig(TWO_BOARDS);
    // Card sits on b3, which is not in the configured allowlist (b1, b2).
    await expect(
      getTrelloCardDetail({ cardId: 'c9' }, { configPath, fetchFn: cardFetch('b3') })
    ).rejects.toThrow(/not available in an authorized board/);
  });

  it('an empty configured board set grants no board', async () => {
    writeConfig({});
    await expect(
      getTrelloCardDetail({ cardId: 'c9' }, { configPath, fetchFn: cardFetch('b1') })
    ).rejects.toThrow(/not available in an authorized board/);
  });

  it('rejects a bad cardId before any network call', async () => {
    writeConfig(TWO_BOARDS);
    await expect(getTrelloCardDetail({ cardId: '../x' }, { configPath })).rejects.toThrow(/cardId/);
  });

  it('pins a section continuation to the card readVersion; a changed card restarts', async () => {
    writeConfig(TWO_BOARDS);
    const first = (await getTrelloCardDetail(
      { cardId: 'c9', section: 'description', limit: 1000 },
      { configPath, fetchFn: cardFetch('b1') }
    )) as { readVersion: string; nextOffset: number | null };
    expect(first.nextOffset).not.toBeNull();
    // The card's live content changed between chunks (still on the authorized board b1).
    const changed = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'c9',
            name: 'ex_100_card',
            due: null,
            dateLastActivity: '2026-07-24T10:00:00.000Z',
            desc: 'e'.repeat(2500),
            labels: [],
            members: [],
            list: { name: 'FB対応' },
            board: { id: 'b1', name: 'Some Board' },
            checklists: [],
          })
        )
    ) as unknown as typeof fetch;
    await expect(
      getTrelloCardDetail(
        {
          cardId: 'c9',
          section: 'description',
          offset: first.nextOffset!,
          readVersion: first.readVersion,
        },
        { configPath, fetchFn: changed }
      )
    ).rejects.toThrow(/content changed/i);
    // A continuation without a readVersion is refused.
    await expect(
      getTrelloCardDetail(
        { cardId: 'c9', section: 'description', offset: 1000 },
        { configPath, fetchFn: cardFetch('b1') }
      )
    ).rejects.toThrow(/requires the readVersion/i);
  });
});
