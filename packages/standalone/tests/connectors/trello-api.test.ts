import { describe, expect, it } from 'vitest';

import { TrelloApi } from '../../src/connectors/trello/api.js';

function action(id: string, date: string) {
  return {
    id,
    type: 'commentCard',
    date,
    data: { card: { id: 'card-a', name: 'Card' }, text: id },
  };
}

describe('TrelloApi', () => {
  it('reads every page of a board window, oldest first, each action once', async () => {
    const start = Date.parse('2026-09-01T00:00:00.000Z');
    const firstPage = Array.from({ length: 1_000 }, (_, index) =>
      action(
        `a-${String(index).padStart(4, '0')}`,
        new Date(start + (2_000 - index) * 1_000).toISOString()
      )
    );
    const secondPage = [firstPage[999]!, action('a-old', new Date(start + 10_000).toISOString())];
    const urls: URL[] = [];
    const api = new TrelloApi({ apiKey: 'fixture-key', token: 'fixture-token' }, async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(urls.length === 1 ? firstPage : secondPage);
    });

    const actions = await api.boardActions('board-a', { fromMs: start });

    expect(actions).toHaveLength(1_001);
    expect(actions[0]!.id).toBe('a-old');
    expect(actions.at(-1)!.id).toBe('a-0000');
    expect(urls).toHaveLength(2);
    expect(urls[0]!.pathname).toBe('/1/boards/board-a/actions');
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({
      filter: 'all',
      since: '2026-09-01T00:00:00.000Z',
      limit: '1000',
      memberCreator: 'true',
      key: 'fixture-key',
      token: 'fixture-token',
    });
    expect(urls[0]!.searchParams.has('before')).toBe(false);
    expect(urls[1]!.searchParams.get('before')).toBe('a-0999');
  });

  it('keeps an action inside the window only', async () => {
    const api = new TrelloApi({ apiKey: 'k', token: 't' }, async () =>
      Response.json([
        action('inside', '2026-09-02T00:00:00.000Z'),
        action('at-until', '2026-09-03T00:00:00.000Z'),
      ])
    );
    const actions = await api.boardActions('board-a', {
      fromMs: Date.parse('2026-09-01T00:00:00.000Z'),
      untilMs: Date.parse('2026-09-03T00:00:00.000Z'),
    });
    expect(actions.map((a) => a.id)).toEqual(['inside']);
  });

  it('fails on an HTTP error and on an action without a valid date', async () => {
    const failing = new TrelloApi(
      { apiKey: 'k', token: 't' },
      async () => new Response(null, { status: 503 })
    );
    await expect(failing.boardActions('board-a', { fromMs: 0 })).rejects.toThrow(
      'Trello /boards/board-a/actions failed with HTTP 503'
    );
    const invalid = new TrelloApi({ apiKey: 'k', token: 't' }, async () =>
      Response.json([action('bad', 'not a date')])
    );
    await expect(invalid.boardActions('board-a', { fromMs: 0 })).rejects.toThrow(
      'Trello action date is invalid'
    );
  });

  it('maps a board label id to its name', async () => {
    const api = new TrelloApi({ apiKey: 'k', token: 't' }, async () =>
      Response.json([
        { id: 'l1', name: 'First round' },
        { id: 'l2', name: '' },
      ])
    );
    expect([...(await api.boardLabels('board-a'))]).toEqual([['l1', 'First round']]);
  });
});
