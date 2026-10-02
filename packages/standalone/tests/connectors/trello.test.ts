import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrelloConnector } from '../../src/connectors/trello/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const envName = 'MAMA_TRELLO_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: {
    'board-key': { role: 'truth', name: 'Board A', boardId: 'board-a' },
    'ignored-key': { role: 'ignore', name: 'Ignored', boardId: 'board-x' },
    'no-board': { role: 'truth', name: 'No board' },
  },
  auth: { type: 'token', tokenName: envName },
};
const move = {
  id: 'action-move',
  type: 'updateCard',
  date: '2026-10-02T01:00:00.000Z',
  data: {
    card: { id: 'card-a', name: 'Still 01' },
    listBefore: { id: 'l1', name: 'Submitted' },
    listAfter: { id: 'l2', name: 'Delivered' },
    old: { idList: 'l1' },
  },
  memberCreator: { id: 'm', fullName: 'Member A' },
};

describe('TrelloConnector', () => {
  beforeEach(() => {
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-key');
    vi.stubEnv(envName, 'fixture-token');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('lists the configured boards as channels', () => {
    expect(new TrelloConnector(config).boards()).toEqual([
      { key: 'board-key', boardId: 'board-a', name: 'Board A' },
    ]);
  });

  it('polls each board for its actions since the cursor and stores them as action items', async () => {
    const urls: URL[] = [];
    const connector = new TrelloConnector(config, async (input) => {
      urls.push(new URL(String(input)));
      return Response.json([move]);
    });
    await connector.init();
    const items = await connector.poll(new Date('2026-10-02T00:55:00.000Z'));

    expect(urls.map((url) => url.pathname)).toEqual(['/1/boards/board-a/actions']);
    expect(urls[0]!.searchParams.get('since')).toBe('2026-10-02T00:55:00.000Z');
    expect(items).toEqual([
      expect.objectContaining({
        sourceId: 'action-move',
        sourceEntityId: 'board-a:card-a',
        channel: 'board-key',
        content: 'Still 01 | Delivered (from: Submitted) | Member A',
        metadata: expect.objectContaining({ actionType: 'updateCard', channelName: 'Board A' }),
      }),
    ]);
    // The same action listed again (the windows overlap) is the same item.
    expect(await connector.poll(new Date('2026-10-02T00:55:00.000Z'))).toEqual(items);
  });

  it('fails the poll when any board fails, returning nothing', async () => {
    const channels = Object.fromEntries(
      ['healthy', 'http', 'caught'].map((id) => [id, { role: 'truth' as const, boardId: id }])
    );
    const connector = new TrelloConnector({ ...config, channels }, async (input) => {
      const url = String(input);
      if (url.includes('/boards/http/')) return new Response(null, { status: 503 });
      if (url.includes('/boards/caught/'))
        throw new TypeError('fetch failed', { cause: new Error('fixture transport error') });
      return Response.json([move]);
    });
    await connector.init();
    await expect(connector.poll(new Date(0))).rejects.toThrow(
      'Trello poll failed for 2 of 3 configured boards; last error: Board caught: fetch failed: fixture transport error'
    );
  });

  it('uses separately stored MAMA_TRELLO_KEY and MAMA_TRELLO_TOKEN', async () => {
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-separate-key');
    vi.stubEnv('MAMA_TRELLO_TOKEN', 'fixture-separate-token');
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('key')).toBe('fixture-separate-key');
      expect(parsed.searchParams.get('token')).toBe('fixture-separate-token');
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new TrelloConnector({
      ...config,
      auth: { type: 'token', tokenName: 'MAMA_TRELLO_TOKEN' },
    });
    await connector.init();
    expect(await connector.authenticate()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to read before init', () => {
    expect(() => new TrelloConnector(config).api()).toThrow('TrelloConnector not initialized');
  });
});
