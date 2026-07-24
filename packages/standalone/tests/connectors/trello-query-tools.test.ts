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
