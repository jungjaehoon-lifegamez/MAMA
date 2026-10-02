import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RawStore } from '../../src/storage/source-archive.js';
import { importTrelloActions } from '../../src/replay/trello-import.js';
import { trelloActionItem } from '../../src/connectors/trello/actions.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function action(id: string, date: string) {
  return {
    id,
    type: 'updateCard',
    date,
    data: {
      board: { id: 'board-a' },
      card: { id: 'card-a', name: 'card' },
      list: { id: 'list-a', name: 'list' },
    },
    idMemberCreator: 'member-a',
    memberCreator: { id: 'member-a', fullName: 'member' },
  };
}

describe('collect-only Trello replay import', () => {
  it('stores an action once when the poll lists an imported action again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-trello-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        trello: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'board-key': { role: 'truth', boardId: 'board-a', name: 'Board A' } },
          auth: { type: 'token' },
        },
      }),
      'utf8'
    );
    const listed = {
      id: 'action-once',
      type: 'updateCard',
      date: '2026-09-02T01:00:00.000Z',
      data: {
        card: { id: 'card-a', name: 'Still 01' },
        listBefore: { id: 'l1', name: 'Submitted' },
        listAfter: { id: 'l2', name: 'Delivered' },
        old: { idList: 'l1' },
      },
      idMemberCreator: 'member-a',
      memberCreator: { id: 'member-a', fullName: 'Member A' },
    };
    let calls = 0;
    const raw = new RawStore(join(root, 'raw'));
    try {
      await importTrelloActions({
        connectorsConfigPath: configPath,
        rawStore: raw,
        rawIndexSink: (connector: string, items: Array<{ sourceId: string }>) =>
          items.map((item) => ({
            sourceId: item.sourceId,
            observationRef: `observation:${connector}:${item.sourceId}`,
          })),
        timeZone: 'Asia/Seoul',
        fetchImpl: async () => Response.json(++calls === 1 ? [listed] : []),
        credentials: { apiKey: 'key', token: 'token' },
        observedAtMs: Date.parse('2026-09-06T00:00:00.000Z'),
        fromMs: Date.parse('2026-09-01T00:00:00.000Z'),
        untilMs: Date.parse('2026-09-06T00:00:00.000Z'),
      });
      const polled = trelloActionItem(
        { key: 'board-key', boardId: 'board-a', name: 'Board A' },
        listed
      );
      // The scheduler stamps the configured name and the poll time on every polled item.
      expect(() =>
        raw.save('trello', [
          {
            ...polled,
            observedAt: Date.parse('2026-09-07T00:00:00.000Z'),
            metadata: { ...polled.metadata, channelName: 'Board A' },
          },
        ])
      ).not.toThrow();
      expect(raw.query('trello', new Date(0))).toHaveLength(1);
      expect(raw.query('trello', new Date(0))[0]).toMatchObject({
        channel: 'board-key',
        content: 'Still 01 | Delivered (from: Submitted) | Member A',
        metadata: { channelName: 'Board A', actionType: 'updateCard' },
      });
    } finally {
      raw.close();
    }
  });

  it('stores each action as a readable line and keeps the action in metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-trello-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        trello: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'board-canonical': { role: 'truth', boardId: 'board-a' } },
          auth: { type: 'token' },
        },
      }),
      'utf8'
    );
    const move = {
      id: 'action-move',
      type: 'updateCard',
      date: '2026-09-02T01:00:00.000Z',
      data: {
        board: { id: 'board-a', name: 'Board' },
        card: { id: 'card-a', name: 'Still 01' },
        listBefore: { id: 'list-a', name: 'Submitted' },
        listAfter: { id: 'list-b', name: 'Month-end delivery' },
        old: { idList: 'list-a' },
      },
      idMemberCreator: 'member-a',
      memberCreator: { id: 'member-a', fullName: 'Member A' },
    };
    const comment = {
      id: 'action-comment',
      type: 'commentCard',
      date: '2026-09-02T02:00:00.000Z',
      data: {
        board: { id: 'board-a' },
        card: { id: 'card-a', name: 'Still 01' },
        text: 'Fixed\nthanks',
      },
      idMemberCreator: 'member-a',
      memberCreator: { id: 'member-a', fullName: 'Member A' },
    };
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(calls === 1 ? [comment, move] : []), { status: 200 });
    };
    const raw = new RawStore(join(root, 'raw'));
    try {
      await importTrelloActions({
        connectorsConfigPath: configPath,
        rawStore: raw,
        rawIndexSink: (connector: string, items: Array<{ sourceId: string }>) =>
          items.map((item) => ({
            sourceId: item.sourceId,
            observationRef: `observation:${connector}:${item.sourceId}`,
          })),
        timeZone: 'Asia/Seoul',
        fetchImpl,
        credentials: { apiKey: 'key', token: 'token' },
        observedAtMs: Date.parse('2026-09-06T00:00:00.000Z'),
        fromMs: Date.parse('2026-09-01T00:00:00.000Z'),
        untilMs: Date.parse('2026-09-06T00:00:00.000Z'),
      });
      const stored = new Map(raw.query('trello', new Date(0)).map((item) => [item.sourceId, item]));
      expect(stored.get('action-move')?.content).toBe(
        'Still 01 | Month-end delivery (from: Submitted) | Member A'
      );
      expect(stored.get('action-comment')?.content).toBe(
        'Still 01 | comment: Fixed / thanks | Member A'
      );
      expect(stored.get('action-move')?.metadata).toMatchObject({
        actionType: 'updateCard',
        data: move.data,
        memberCreator: move.memberCreator,
      });
    } finally {
      raw.close();
    }
  });

  it('pages beyond 1,000 actions and keeps stable action identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-trello-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        trello: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'board-canonical': { role: 'truth', boardId: 'board-a' } },
          auth: { type: 'token' },
        },
      }),
      'utf8'
    );
    const firstDate = Date.parse('2026-09-05T00:00:00.000Z');
    const firstPage = Array.from({ length: 1_000 }, (_, index) =>
      action(`action-${index}`, new Date(firstDate - index * 1_000).toISOString())
    );
    const secondPage = [
      action('action-1000', '2026-09-04T23:43:00.000Z'),
      action('action-1001', '2026-09-01T00:00:01.000Z'),
    ];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      const body = calls === 1 ? firstPage : calls === 2 ? secondPage : [];
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const raw = new RawStore(join(root, 'raw'));
    const manifestPath = join(root, 'manifest.json');
    const rawIndexSink = (connector: string, items: Array<{ sourceId: string }>) =>
      items.map((item) => ({
        sourceId: item.sourceId,
        observationRef: `observation:${connector}:${item.sourceId}`,
      }));
    try {
      const result = await importTrelloActions({
        connectorsConfigPath: configPath,
        rawStore: raw,
        rawIndexSink,
        timeZone: 'Asia/Seoul',
        fetchImpl,
        credentials: { apiKey: 'key', token: 'token' },
        observedAtMs: Date.parse('2026-09-06T00:00:00.000Z'),
        fromMs: Date.parse('2026-09-01T00:00:00.000Z'),
        untilMs: Date.parse('2026-09-06T00:00:00.000Z'),
        manifestPath,
      });

      expect(calls).toBe(2);
      expect(result.importedCount).toBe(1_002);
      expect(raw.query('trello', new Date(0))).toHaveLength(1_002);
      expect(
        raw.query('trello', new Date(0)).find((item) => item.sourceId === 'action-0')
      ).toMatchObject({
        source: 'trello',
        sourceId: 'action-0',
        sourceEntityId: 'action-0',
        channel: 'board-canonical',
        type: 'kanban_card',
      });
      expect(raw.listPendingProjections('trello')).toEqual([]);
      expect(JSON.parse(readFileSync(manifestPath, 'utf8')).trelloCountsByBoardDay).toEqual({
        'board-a': { '2026-09-01': 1, '2026-09-05': 1_001 },
      });

      const again = await importTrelloActions({
        connectorsConfigPath: configPath,
        rawStore: raw,
        rawIndexSink,
        timeZone: 'Asia/Seoul',
        fetchImpl,
        credentials: { apiKey: 'key', token: 'token' },
        observedAtMs: Date.parse('2026-09-07T00:00:00.000Z'),
        fromMs: Date.parse('2026-09-01T00:00:00.000Z'),
        untilMs: Date.parse('2026-09-06T00:00:00.000Z'),
      });
      expect(again.importedCount).toBe(0);
      expect(raw.query('trello', new Date(0))).toHaveLength(1_002);
    } finally {
      raw.close();
    }
  });
});
