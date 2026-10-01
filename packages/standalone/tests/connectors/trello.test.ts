import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrelloConnector } from '../../src/connectors/trello/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

let root: string;
const envName = 'MAMA_TRELLO_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'channel-key': { role: 'truth', name: 'board-display', boardId: 'board-key' } },
  auth: { type: 'token', tokenName: envName },
};

function lists(cards: unknown[]): unknown[] {
  return [{ id: 'list-key', name: 'list-display', cards }];
}

describe('TrelloConnector', () => {
  it.each([false, true])(
    'counts a board with multiple invalid timestamps once, even with a later catch=%s',
    async (laterCatch) => {
      const invalid = {
        id: 'invalid-card',
        name: 'invalid',
        idMembers: [],
        labels: [],
        dateLastActivity: 'invalid',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            lists([
              invalid,
              { ...invalid, id: 'second-invalid' },
              ...(laterCatch
                ? [{ ...invalid, id: 'throwing-card', dateLastActivity: '2024-01-01', labels: {} }]
                : []),
            ])
          )
        )
      );
      const connector = new TrelloConnector(config, join(root, 'state.json'));
      await connector.init();
      await expect(connector.poll(new Date(0))).rejects.toThrow(
        /failed for 1 of 1 configured boards; last error:/
      );
    }
  );

  it('counts timestamp, HTTP and caught failures across distinct boards and resets each poll', async () => {
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!failing || url.includes('/healthy/')) return Response.json([]);
        if (url.includes('/http/')) return new Response(null, { status: 503 });
        if (url.includes('/caught/'))
          throw new TypeError('fetch failed', { cause: new Error('fixture transport error') });
        return Response.json(
          lists([
            { id: 'invalid-card', name: 'invalid', idMembers: [], dateLastActivity: 'invalid' },
          ])
        );
      })
    );
    const channels = Object.fromEntries(
      ['invalid', 'http', 'caught', 'healthy'].map((id) => [
        id,
        { role: 'truth' as const, boardId: id },
      ])
    );
    const connector = new TrelloConnector({ ...config, channels }, join(root, 'state.json'));
    await connector.init();
    await expect(connector.poll(new Date(0))).rejects.toThrow(
      'failed for 3 of 4 configured boards; last error: Board caught: fetch failed: fixture transport error'
    );
    failing = false;
    await expect(connector.poll(new Date(0))).resolves.toEqual([]);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trello-connector-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-key');
    vi.stubEnv(envName, 'fixture-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses separately stored MAMA_TRELLO_KEY and MAMA_TRELLO_TOKEN', async () => {
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-separate-key');
    vi.stubEnv('MAMA_TRELLO_TOKEN', 'fixture-separate-token');
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('key') === 'fixture-separate-key').toBe(true);
      expect(parsed.searchParams.get('token') === 'fixture-separate-token').toBe(true);
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new TrelloConnector(
      { ...config, auth: { type: 'token', tokenName: 'MAMA_TRELLO_TOKEN' } },
      join(root, 'state.json')
    );
    await connector.init();
    expect(await connector.authenticate()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit state file path', () => {
    expect(() => new TrelloConnector(config, undefined as unknown as string)).toThrow(
      /state file path/i
    );
  });

  it('filters the initial poll by card activity time', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        lists([
          {
            id: 'old-card',
            name: 'old',
            idMembers: [],
            labels: [],
            dateLastActivity: '2023-12-31T23:59:59.000Z',
          },
          {
            id: 'new-card',
            name: 'new',
            idMembers: [],
            labels: [],
            dateLastActivity: '2024-01-01T00:00:01.000Z',
          },
        ]),
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new TrelloConnector(config, join(root, 'state.json'));
    await connector.init();
    const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
    expect(items.map((item) => item.sourceId)).toEqual(['board-key:new-card:1704067201000']);
  });

  it('stages card state until the poll handoff is committed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        lists([
          {
            id: 'card-key',
            name: 'card',
            idMembers: [],
            labels: [],
            dateLastActivity: '2024-01-01T00:00:01.000Z',
          },
        ]),
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new TrelloConnector(config, join(root, 'state.json'));
    await connector.init();
    connector.beginPollHandoff?.();
    await connector.poll(new Date(0));
    connector.abortPollHandoff?.();
    connector.beginPollHandoff?.();
    expect(await connector.poll(new Date(0))).toHaveLength(1);
    connector.commitPoll?.();
    expect(await connector.poll(new Date(0))).toHaveLength(0);
  });
});
