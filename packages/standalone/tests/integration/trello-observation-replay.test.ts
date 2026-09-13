import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { upsertConnectorEventIndex } from '../../../mama-core/src/connectors/event-index.js';
import {
  mapNormalizedItemsToConnectorEventIndexInputs,
  RawStore,
} from '@jungjaehoon/mama-core/storage/source-archive';
import { TrelloConnector } from '../../src/connectors/trello/index.js';
import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';

describe('Story TG-03/TG-04/TG-05/TG-06: real Trello observation replay', () => {
  let corePath = '';
  beforeAll(async () => {
    corePath = await initTestDB('trello-observation-replay');
  });
  beforeEach(() => {
    getAdapter().prepare('DELETE FROM connector_event_index').run();
    getAdapter().prepare('DELETE FROM observation_versions').run();
  });
  afterAll(async () => cleanupTestDB(corePath));

  it('AC #1 commits provider state only after durable raw and core projection handoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-trello-observation-'));
    const statePath = join(dir, 'state', 'trello-state.json');
    const rawStore = new RawStore(join(dir, 'raw'));
    try {
      const captureStartedAt = Date.now();
      let board = [
        {
          id: 'backlog',
          name: 'Backlog',
          cards: [
            {
              id: 'card1',
              name: 'A',
              idMembers: [],
              labels: [],
              dateLastActivity: '2026-09-11T00:00:00.000Z',
            },
          ],
        },
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => board }))
      );
      const connector = new TrelloConnector(
        {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { board: { role: 'hub', name: 'board', boardId: 'b1' } },
          auth: { type: 'token', token: 'key:token' },
        },
        { stateFilePath: statePath }
      );
      await connector.init();
      const registry = new ConnectorRegistry();
      registry.register('trello', connector);
      let failCore = true;
      const scheduler = new PollingScheduler(rawStore, dir, {
        rawIndexSink: async (name, items) => {
          if (failCore) {
            failCore = false;
            throw new Error('forced core failure');
          }
          for (const input of mapNormalizedItemsToConnectorEventIndexInputs(name, items)) {
            upsertConnectorEventIndex(getAdapter(), input);
          }
        },
      });

      await scheduler.pollAll(registry, { trello: { board: { role: 'hub' } } }, vi.fn());
      expect(existsSync(statePath)).toBe(false);
      const firstPending = rawStore.listPendingProjections('trello');
      expect(firstPending).toHaveLength(1);
      const firstCapturedAt = firstPending[0]!.observedAt;
      expect(firstCapturedAt).toBeGreaterThanOrEqual(captureStartedAt);

      await connector.dispose();
      const reopened = new TrelloConnector(
        {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { board: { role: 'hub', name: 'board', boardId: 'b1' } },
          auth: { type: 'token', token: 'key:token' },
        },
        { stateFilePath: statePath }
      );
      await reopened.init();
      const reopenedRegistry = new ConnectorRegistry();
      reopenedRegistry.register('trello', reopened);
      await scheduler.pollAll(reopenedRegistry, { trello: { board: { role: 'hub' } } }, vi.fn());
      expect(rawStore.listPendingProjections('trello')).toEqual([]);
      expect(readFileSync(statePath, 'utf8')).toContain('card1');
      const replayedRows = getAdapter()
        .prepare(
          `SELECT observation_id, source_id, content_hash, observed_at
             FROM observation_versions WHERE source_connector = 'trello'`
        )
        .all();
      expect(replayedRows).toHaveLength(1);

      board = [
        {
          id: 'done',
          name: 'Done',
          cards: [
            {
              id: 'card1',
              name: 'B',
              idMembers: [],
              labels: [],
              dateLastActivity: '2026-09-12T00:00:00.000Z',
            },
          ],
        },
      ];
      await scheduler.pollAll(reopenedRegistry, { trello: { board: { role: 'hub' } } }, vi.fn());
      const observations = getAdapter()
        .prepare(
          `SELECT source_id, observed_at, source_at FROM observation_versions
         WHERE source_connector = 'trello' ORDER BY observed_at, observation_id`
        )
        .all() as Array<{ source_id: string; observed_at: number; source_at: number }>;
      expect(observations).toHaveLength(2);
      expect(observations[0]!.observed_at).toBe(firstCapturedAt);
      expect(observations[0]!.source_at).toBe(Date.parse('2026-09-11T00:00:00.000Z'));
      expect(new Set(observations.map((row) => row.source_id)).size).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      rawStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC #2 retries a failed provider checkpoint and extracts the durable item once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-trello-checkpoint-retry-'));
    const blocker = join(dir, 'state-parent');
    const statePath = join(blocker, 'trello-state.json');
    writeFileSync(blocker, 'blocks directory creation');
    const rawStore = new RawStore(join(dir, 'raw'));
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => [
            {
              id: 'backlog',
              name: 'Backlog',
              cards: [
                {
                  id: 'card-retry',
                  name: 'Retry card',
                  idMembers: [],
                  labels: [],
                  dateLastActivity: '2026-09-11T00:00:00.000Z',
                },
              ],
            },
          ],
        }))
      );
      const connector = new TrelloConnector(
        {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { board: { role: 'hub', name: 'board', boardId: 'b-retry' } },
          auth: { type: 'token', token: 'key:token' },
        },
        { stateFilePath: statePath }
      );
      await connector.init();
      const registry = new ConnectorRegistry();
      registry.register('trello', connector);
      const extract = vi.fn();
      const scheduler = new PollingScheduler(rawStore, dir, {
        rawIndexSink: async (name, items) => {
          for (const input of mapNormalizedItemsToConnectorEventIndexInputs(name, items)) {
            upsertConnectorEventIndex(getAdapter(), input);
          }
        },
      });

      await scheduler.pollAll(registry, { trello: { board: { role: 'hub' } } }, extract);
      expect(extract).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
      rmSync(blocker);
      mkdirSync(blocker);

      await scheduler.pollAll(registry, { trello: { board: { role: 'hub' } } }, extract);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(readFileSync(statePath, 'utf8')).toContain('card-retry');
      expect(rawStore.listPendingProjections('trello')).toEqual([]);
      expect(
        getAdapter()
          .prepare(
            `SELECT COUNT(*) AS count FROM observation_versions
             WHERE source_connector = 'trello' AND source_id LIKE 'b-retry:%'`
          )
          .get()
      ).toEqual({ count: 1 });
    } finally {
      vi.unstubAllGlobals();
      rawStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
