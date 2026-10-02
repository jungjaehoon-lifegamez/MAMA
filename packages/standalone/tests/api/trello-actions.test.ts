import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import { trelloActionRegistrations } from '../../src/api/trello-actions.js';
import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { TrelloConnector } from '../../src/connectors/trello/index.js';
import { openCoreDatabase, type CoreDatabase } from '../../src/runtime/core-db.js';

const lists = [
  { id: 'l1', name: 'Doing', cards: [{ id: 'c1' }, { id: 'c2' }] },
  { id: 'l2', name: 'Submitted', cards: [{ id: 'c3' }] },
];
const card = (id: string, idList: string) => ({
  id,
  name: `Card ${id}`,
  idList,
  idBoard: 'board-a',
  idMembers: ['m1'],
  labels: [{ id: 'lab1', name: 'First round' }],
  due: null,
  dueComplete: false,
  dateLastActivity: '2026-10-02T01:00:00.000Z',
  shortUrl: `https://trello.example/${id}`,
});

function trelloFixture(url: URL): unknown {
  const path = url.pathname.replace(/^\/1/, '');
  if (path === '/boards/board-a/lists') return lists;
  if (path === '/boards/board-b/lists' || path === '/boards/board-b/labels') return [];
  if (path === '/boards/board-a/members') return [{ id: 'm1', fullName: 'Member A' }];
  if (path === '/boards/board-a/cards/open')
    return [card('c1', 'l1'), card('c2', 'l1'), card('c3', 'l2')];
  if (path === '/lists/l2/cards') return [card('c3', 'l2')];
  if (path === '/boards/board-a/labels')
    return [
      { id: 'lab1', name: 'First round' },
      { id: 'lab2', name: 'Second round' },
    ];
  if (path === '/cards/c3')
    return {
      ...card('c3', 'l2'),
      desc: 'Brief',
      closed: false,
      list: { id: 'l2', name: 'Submitted' },
      members: [{ id: 'm1', fullName: 'Member A' }],
      checklists: [{ name: 'Check', checkItems: [{ name: 'Pose', state: 'complete' }] }],
      actions: [
        {
          id: 'act-labels',
          type: 'updateCard',
          date: '2026-10-02T00:30:00.000Z',
          data: {
            card: { id: 'c3', name: 'Card c3', idLabels: ['lab2'] },
            old: { idLabels: ['lab1'] },
          },
          memberCreator: { fullName: 'Member A' },
        },
      ],
    };
  if (path === '/cards/c9')
    return {
      ...card('c9', 'lx'),
      idBoard: 'board-b',
      list: { name: 'X' },
      members: [],
      checklists: [],
      actions: [],
    };
  if (path === '/search')
    return { cards: [{ ...card('c1', 'l1'), list: { id: 'l1', name: 'Doing' } }] };
  throw new Error(`unexpected ${path}`);
}

let home: string;
let db: CoreDatabase;
let requested: URL[];

const boardsConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: {
    'board-key': { role: 'truth' as const, name: 'Board A', boardId: 'board-a' },
    'board-b-key': { role: 'truth' as const, name: 'Board B', boardId: 'board-b' },
  },
  auth: { type: 'token' as const },
};
const oneBoard = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'board-key': { role: 'truth' as const, boardId: 'board-a' } },
  auth: { type: 'token' as const },
};

async function dispatcherFor(connector: TrelloConnector) {
  await connector.init();
  const registry = new ConnectorRegistry();
  registry.register('trello', connector);
  return createDispatcher(
    createCatalog(
      trelloActionRegistrations({
        connectors: () => registry,
        adapter: db.adapter,
        ownerPrincipalId: 'owner',
      })
    )
  );
}

async function setup() {
  home = mkdtempSync(join(tmpdir(), 'trello-read-'));
  db = await openCoreDatabase({ path: join(home, 'state.db') });
  upsertConnectorEventIndex(db.adapter, {
    source_connector: 'trello',
    source_type: 'kanban_card',
    source_id: 'act-labels',
    channel: 'board-key',
    content: 'Card c3 | labels changed | Member A',
    source_timestamp_ms: Date.parse('2026-10-02T00:30:00.000Z'),
  });
  requested = [];
  const dispatch = await dispatcherFor(
    new TrelloConnector(boardsConfig, async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      return Response.json(trelloFixture(url));
    })
  );
  const owner: ActionContext['access'] = {
    principalId: 'owner',
    agentId: 'agent',
    actions: ['trello.read'],
    connectors: ['trello'],
    scopes: [],
  };
  const member: ActionContext['access'] = {
    ...owner,
    principalId: 'member',
    channels: { trello: ['board-key'] },
  };
  return { dispatch, owner, member };
}

describe('trello.read', () => {
  beforeEach(() => {
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-key');
    vi.stubEnv('MAMA_TRELLO_TOKEN', 'fixture-token');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('lists the boards with their lists and open card counts', async () => {
    const { dispatch, owner } = await setup();
    const result = await dispatch(
      { action: 'trello.read', input: { view: 'boards' } },
      { access: owner }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: {
        boards: [
          {
            board: 'board-key',
            name: 'Board A',
            lists: [
              { id: 'l1', name: 'Doing', openCards: 2 },
              { id: 'l2', name: 'Submitted', openCards: 1 },
            ],
          },
          { board: 'board-b-key', name: 'Board B', lists: [] },
        ],
      },
    });
  });

  it('reads the open cards of a board or one list with list, label and member names', async () => {
    const { dispatch, owner } = await setup();
    const all = await dispatch(
      { action: 'trello.read', input: { view: 'cards', board: 'board-key' } },
      { access: owner }
    );
    expect(all).toMatchObject({
      status: 'completed',
      data: {
        cards: [
          { id: 'c1', list: 'Doing', labels: ['First round'], members: ['Member A'] },
          {},
          {},
        ],
      },
    });
    const one = await dispatch(
      { action: 'trello.read', input: { view: 'cards', board: 'board-key', list: 'l2' } },
      { access: owner }
    );
    expect(one).toMatchObject({
      status: 'completed',
      data: { cards: [{ id: 'c3', list: 'Submitted' }] },
    });
  });

  it('reads one card with its actions, naming labels and the stored observation', async () => {
    const { dispatch, owner } = await setup();
    const stored = db.adapter
      .prepare(
        "SELECT current_observation_id AS ref FROM connector_event_index WHERE source_id = 'act-labels'"
      )
      .get() as { ref: string };
    const result = await dispatch(
      { action: 'trello.read', input: { view: 'card', id: 'c3' } },
      { access: owner }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: {
        card: {
          id: 'c3',
          board: 'board-key',
          list: 'Submitted',
          description: 'Brief',
          labels: ['First round'],
          members: ['Member A'],
          checklists: [{ name: 'Check', items: [{ name: 'Pose', state: 'complete' }] }],
          actions: [
            {
              time: '2026-10-02T00:30:00.000Z',
              line: 'Card c3 | labels First round -> Second round | Member A',
              observationRef: stored.ref,
            },
          ],
        },
      },
    });
  });

  it('searches the granted boards only', async () => {
    const { dispatch, member } = await setup();
    const result = await dispatch(
      { action: 'trello.read', input: { view: 'search', query: 'Card' } },
      { access: member }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { cards: [{ id: 'c1', list: 'Doing' }] },
    });
    const search = requested.find((url) => url.pathname === '/1/search')!;
    expect(search.searchParams.get('idBoards')).toBe('board-a');
    expect(search.searchParams.get('cards_limit')).toBe('10');
  });

  it('denies a board or a card outside the grant and refuses an unconfigured board', async () => {
    const { dispatch, member, owner } = await setup();
    expect(
      await dispatch(
        { action: 'trello.read', input: { view: 'cards', board: 'board-b-key' } },
        { access: member }
      )
    ).toMatchObject({ status: 'failed', error: { code: 'trello_board_out_of_scope' } });
    expect(
      await dispatch(
        { action: 'trello.read', input: { view: 'card', id: 'c9' } },
        { access: member }
      )
    ).toMatchObject({ status: 'failed', error: { code: 'trello_board_out_of_scope' } });
    expect(
      await dispatch(
        { action: 'trello.read', input: { view: 'cards', board: 'nowhere' } },
        { access: owner }
      )
    ).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: expect.stringContaining('board-key') },
    });
  });

  it('refuses a query over twenty terms and a page over one hundred cards', async () => {
    const { dispatch, owner } = await setup();
    const query = Array.from({ length: 21 }, (_, i) => `t${i}`).join(' ');
    expect(
      await dispatch({ action: 'trello.read', input: { view: 'search', query } }, { access: owner })
    ).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
    const many = Array.from({ length: 101 }, (_, i) => card(`m${i}`, 'l1'));
    const big = await dispatcherFor(
      new TrelloConnector(oneBoard, async (input) => {
        const url = new URL(String(input));
        return Response.json(url.pathname.endsWith('/cards/open') ? many : trelloFixture(url));
      })
    );
    expect(
      await big(
        { action: 'trello.read', input: { view: 'cards', board: 'board-key' } },
        { access: owner }
      )
    ).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: expect.stringContaining('l1 Doing') },
    });
  });

  it('passes a Trello failure through as the action error', async () => {
    const { owner } = await setup();
    const failing = await dispatcherFor(
      new TrelloConnector(oneBoard, async () => new Response(null, { status: 429 }))
    );
    expect(
      await failing({ action: 'trello.read', input: { view: 'boards' } }, { access: owner })
    ).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('HTTP 429') } });
  });
});
