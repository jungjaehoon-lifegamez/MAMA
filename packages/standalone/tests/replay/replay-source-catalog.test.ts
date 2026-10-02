import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../../src/sqlite.js';
import {
  REPLAY_WINDOW_SIZE_MS,
  ReplaySourceCatalog,
  readReplaySourceEvents,
  type ReplaySourceEvent,
} from '../../src/replay/replay-source-catalog.js';
import type { WindowQueue } from '../../src/replay/window-queue.js';
import { trelloActionLine } from '../../src/connectors/trello/action-line.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const HOUR = 60 * 60 * 1_000;
const start = Date.parse('2026-09-01T00:00:00.000+09:00');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(overrides: Partial<ReplaySourceEvent> = {}): ReplaySourceEvent {
  return {
    connector: 'slack',
    sourceId: 'source-a',
    observationRef: 'observation-a',
    channelKey: 'channel-a',
    sourceAtMs: start + HOUR,
    observedAtMs: start + 100 * HOUR,
    rawRowId: 1,
    author: 'sender',
    contentPreview: 'message content',
    ...overrides,
  };
}

describe('ReplaySourceCatalog', () => {
  it('sorts source events globally into one cross-channel daily delta', () => {
    const catalog = new ReplaySourceCatalog(
      [
        event({
          connector: 'trello',
          sourceId: 'source-c',
          observationRef: 'observation-c',
          channelKey: 'board-a',
          sourceAtMs: start + 3 * HOUR,
          rawRowId: 3,
        }),
        event({
          connector: 'slack',
          sourceId: 'source-b',
          observationRef: 'observation-b',
          sourceAtMs: start + 2 * HOUR,
          rawRowId: 2,
        }),
        event({ sourceAtMs: start + HOUR, rawRowId: 1 }),
        event({
          connector: 'slack',
          sourceId: 'source-d',
          observationRef: 'observation-d',
          channelKey: 'channel-b',
          sourceAtMs: start + HOUR,
          rawRowId: 4,
        }),
      ],
      createTimeZoneSetting('Asia/Seoul')
    );

    const deltas = catalog.deltasForWindow('run-1', start, start + 12 * HOUR);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.collector).toBe('replay');
    expect(deltas[0]?.refs.map((ref) => ref.sourceId)).toEqual([
      'source-a',
      'source-d',
      'source-b',
      'source-c',
    ]);
    expect(deltas[0]).toMatchObject({
      kind: 'source_delta',
      occurredAt: start + 3 * HOUR,
      replay: {
        runId: 'run-1',
        windowId: `window:${start}:${start + 12 * HOUR}`,
        windowStartMs: start,
        windowEndMs: start + 12 * HOUR,
      },
    });
    expect(deltas[0]?.refs[0]).toMatchObject({
      channel: 'channel-a',
      author: 'sender',
      contentPreview: 'message content',
    });
    expect(deltas[0]?.refs[0]?.observedAt).toBe(new Date(start + 100 * HOUR).toISOString());

    const withLedger = catalog.deltasForWindow('run-1', start, start + 12 * HOUR, {
      ledgerDigest: [
        {
          commitmentId: 'commitment-1',
          title: 'Current item',
          stage: 'active',
          status: 'pending',
          assignee: 'worker',
          lastEventTime: new Date(start).toISOString(),
        },
      ],
      queue: {
        window: { startMs: start, endMs: start + 12 * HOUR },
        lines: [],
        sections: { a: [], b: [], c: [], suspectedDuplicates: [], unresolved: [] },
      } satisfies WindowQueue,
    });
    expect(withLedger[0]?.replay?.ledgerDigest).toHaveLength(1);
    expect(withLedger[0]?.replay?.queue?.window.startMs).toBe(start);
  });

  it('keeps descriptors immutable and rejects an event outside its declared range', () => {
    const descriptor = event();
    const catalog = new ReplaySourceCatalog([descriptor], createTimeZoneSetting('UTC'));
    descriptor.sourceId = 'mutated-after-construction';

    expect(catalog.eventsForWindow(start, start + 12 * HOUR)[0]?.sourceId).toBe('source-a');
    expect(catalog.eventsForWindow(start + 12 * HOUR, start + 24 * HOUR)).toEqual([]);
    expect(REPLAY_WINDOW_SIZE_MS).toBe(24 * HOUR);
  });

  it('creates KST-aligned daily windows through the frozen fence', () => {
    const catalog = new ReplaySourceCatalog([], createTimeZoneSetting('Asia/Seoul'));
    const windows = catalog.windows(start, start + 25 * HOUR);

    expect(windows).toEqual([
      { startMs: start, endMs: start + 24 * HOUR },
      { startMs: start + 24 * HOUR, endMs: start + 25 * HOUR },
    ]);
  });

  it('uses the immutable row id from every raw store when a raw root is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-catalog-'));
    roots.push(root);
    mkdirSync(join(root, 'slack'), { recursive: true });
    const raw = new Database(join(root, 'slack', 'raw.db'));
    raw.exec(`
      CREATE TABLE raw_items (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    raw
      .prepare('INSERT INTO raw_items (id, source_id, timestamp) VALUES (?, ?, ?)')
      .run(77, 'source-a', start + HOUR);
    raw.close();
    const adapter = {
      prepare: () => ({
        all: () => [
          {
            connector: 'slack',
            source_id: 'source-a',
            observation_ref: 'observation-a',
            channel_key: 'channel-a',
            source_at_ms: start + HOUR,
            raw_row_id: 1,
            author: 'sender',
            content: 'content-a',
            observed_at_ms: start + 2 * HOUR,
            source_entity_id: 'source-a',
            metadata_json: null,
            content_hash: null,
          },
        ],
      }),
    };

    expect(
      readReplaySourceEvents(adapter, start, start + 12 * HOUR, {
        rawRoot: root,
        timeZone: createTimeZoneSetting('UTC'),
      })[0]?.rawRowId
    ).toBe(77);
  });

  it('names the channel, keeps the whole message and renders a Trello action as one line', () => {
    const row = (overrides: Record<string, unknown>) => ({
      source_at_ms: start + HOUR,
      raw_row_id: 1,
      observed_at_ms: start + 2 * HOUR,
      source_entity_id: null,
      metadata_json: null,
      content_hash: null,
      ...overrides,
    });
    const longText = 'x'.repeat(900);
    const trelloAction = {
      type: 'updateCard',
      memberCreator: { fullName: 'board member' },
      data: {
        board: { name: 'board-name' },
        card: { name: 'asset-card' },
        listBefore: { name: 'waiting' },
        listAfter: { name: 'submitted' },
      },
    };
    const adapter = {
      prepare: () => ({
        all: () => [
          row({
            connector: 'chatwork',
            source_id: 'message-1',
            observation_ref: 'obs-1',
            channel_key: 'room-1',
            author: 'sender',
            content: longText,
          }),
          row({
            connector: 'trello',
            source_id: 'action-1',
            observation_ref: 'obs-2',
            channel_key: 'board-1',
            author: 'trello',
            content: trelloActionLine(trelloAction),
            metadata_json: JSON.stringify({
              actionType: trelloAction.type,
              data: trelloAction.data,
              memberCreator: trelloAction.memberCreator,
            }),
          }),
          row({
            connector: 'trello',
            source_id: 'snapshot-1',
            observation_ref: 'obs-3',
            channel_key: 'board-1',
            author: 'trello',
            content: '[Card] asset-card | list: submitted',
            metadata_json: JSON.stringify({ cardId: 'card-1', listName: 'submitted' }),
          }),
        ],
      }),
    };
    const [message, action, snapshot] = readReplaySourceEvents(adapter, start, start + 12 * HOUR, {
      channelNames: new Map([
        ['chatwork\0room-1', 'client room'],
        ['trello\0board-1', 'client board'],
      ]),
      timeZone: createTimeZoneSetting('UTC'),
    });
    expect(message).toMatchObject({ channelName: 'client room', contentPreview: longText });
    expect(snapshot).toMatchObject({ contentPreview: '[Card] asset-card | list: submitted' });
    expect(action).toMatchObject({
      channelName: 'client board',
      author: 'board member',
      contentPreview: 'asset-card | submitted (from: waiting) | board member',
    });
  });
});
