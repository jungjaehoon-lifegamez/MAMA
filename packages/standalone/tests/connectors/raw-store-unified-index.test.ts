import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { searchAllRaw } from '../../../mama-core/src/connectors/raw-query.js';
import { upsertConnectorEventIndex } from '../../../mama-core/src/connectors/event-index.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import {
  RawStore,
  mapNormalizedItemsToConnectorEventIndexInputs,
} from '@jungjaehoon/mama-core/storage/source-archive';
import type { IConnector, NormalizedItem } from '../../src/connectors/framework/types.js';

function makeItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    source: 'slack',
    sourceId: 'msg-1',
    channel: 'C123',
    author: 'alice',
    content: 'unifiedindex searchable body',
    timestamp: new Date('2026-04-20T10:00:00.000Z'),
    sourceCursor: 'cursor-1',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    memoryScopeKind: 'project',
    memoryScopeId: 'project-a',
    type: 'message',
    metadata: { thread: 'T1' },
    ...overrides,
  };
}

function makeConnector(name: string, items: NormalizedItem[]): IConnector {
  return {
    name,
    type: 'api',
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, lastPollTime: null, lastPollCount: 0 }),
    getAuthRequirements: vi.fn().mockReturnValue([]),
    authenticate: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue(items),
  };
}

describe('Story M4: RawStore to unified connector_event_index indexing', () => {
  let testDbPath = '';
  let tmpDir = '';
  let rawStore: RawStore;

  beforeAll(async () => {
    testDbPath = await initTestDB('raw-store-unified-index');
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raw-unified-index-'));
    rawStore = new RawStore(tmpDir);
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index_cursors').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
    adapter.prepare('DELETE FROM observation_versions').run();
  });

  afterEach(() => {
    rawStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: PollingScheduler can index saved raw rows into the unified index', () => {
    it('TG-03/TG-05 indexes both revisions using the exact persisted source locators', async () => {
      let incoming = makeItem({ content: 'revisionsearch original' });
      const connector = makeConnector('slack', []);
      connector.poll = async () => [incoming];
      const registry = new ConnectorRegistry();
      registry.register('slack', connector);
      const scheduler = new PollingScheduler(rawStore, tmpDir, {
        rawIndexSink: async (name, items) => {
          const stored = rawStore.query(name, new Date(0));
          for (const item of items) {
            const { pendingProjectionId: _pendingProjectionId, ...persistedItem } = item;
            expect(stored.find((row) => row.sourceId === item.sourceId)).toEqual({
              ...persistedItem,
              observedAt: undefined,
            });
          }
          for (const row of mapNormalizedItemsToConnectorEventIndexInputs(name, items)) {
            upsertConnectorEventIndex(getAdapter(), row);
          }
        },
      });
      await scheduler.pollAll(registry, { slack: { C123: { role: 'hub' } } }, async () => {});
      incoming = { ...incoming, content: 'revisionsearch changed' };
      await scheduler.pollAll(registry, { slack: { C123: { role: 'hub' } } }, async () => {});
      await scheduler.pollAll(registry, { slack: { C123: { role: 'hub' } } }, async () => {});
      expect(rawStore.query('slack', new Date(0))).toHaveLength(2);
      const rows = getAdapter()
        .prepare('SELECT source_id, content FROM connector_event_index ORDER BY source_id')
        .all();
      expect(rows).toEqual(
        rawStore
          .query('slack', new Date(0))
          .map((item) => ({ source_id: item.sourceId, content: item.content }))
      );
    });

    it('maps NormalizedItem provenance fields and indexes after RawStore.save succeeds', async () => {
      const scheduler = new PollingScheduler(rawStore, tmpDir, {
        rawIndexSink: async (connectorName, items) => {
          for (const input of mapNormalizedItemsToConnectorEventIndexInputs(connectorName, items)) {
            upsertConnectorEventIndex(getAdapter(), input);
          }
        },
      });
      const registry = new ConnectorRegistry();
      registry.register('slack', makeConnector('slack', [makeItem()]));

      await scheduler.pollAll(registry, { slack: { C123: { role: 'hub' } } }, vi.fn());

      const hits = searchAllRaw(getAdapter(), {
        query: 'unifiedindex',
        connectors: ['slack'],
        scopes: [{ kind: 'project', id: 'project-a' }],
        limit: 5,
      }).hits;
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        connector: 'slack',
        source_id: 'msg-1',
        channel_id: 'C123',
        author_label: 'alice',
        source_ref: 'slack:C123:msg-1',
      });
      expect(hits[0]?.metadata).toEqual({ thread: 'T1', sourceEntityId: 'msg-1' });
      expect(scheduler.getLastPollTime('slack')).toBeInstanceOf(Date);
    });
  });

  describe('AC #2: index sink failure keeps cursor unchanged for idempotent retry', () => {
    it('does not commit the provider checkpoint when exact batch acknowledgement fails', async () => {
      const connector = makeConnector('slack', [
        makeItem({ sourceId: 'ack-one' }),
        makeItem({ sourceId: 'ack-two', content: 'second pending projection' }),
      ]);
      connector.commitPoll = vi.fn().mockResolvedValue(undefined);
      const registry = new ConnectorRegistry();
      registry.register('slack', connector);
      vi.spyOn(rawStore, 'acknowledgeProjections').mockImplementation(() => {
        throw new Error('synthetic exact acknowledgement failure');
      });
      const scheduler = new PollingScheduler(rawStore, tmpDir, {
        rawIndexSink: async () => {},
      });

      await scheduler.pollAll(registry, { slack: { C123: { role: 'hub' } } }, vi.fn());

      expect(connector.commitPoll).not.toHaveBeenCalled();
      expect(rawStore.listPendingProjections('slack')).toHaveLength(2);
      expect(scheduler.getLastPollTime('slack')).toBeUndefined();
    });

    it('does not advance lastPollTimes until poll, raw save, and index sink all succeed', async () => {
      const onExtract = vi.fn();
      const indexError = new Error('index unavailable');
      const sink = vi.fn().mockRejectedValueOnce(indexError).mockResolvedValueOnce(undefined);
      const scheduler = new PollingScheduler(rawStore, tmpDir, { rawIndexSink: sink });
      const registry = new ConnectorRegistry();
      const connector = makeConnector('slack', [makeItem()]);
      registry.register('slack', connector);

      await scheduler.pollAll(registry, { slack: { C123: { role: 'hub' } } }, onExtract);

      expect(rawStore.query('slack', new Date(0))).toHaveLength(1);
      expect(scheduler.getLastPollTime('slack')).toBeUndefined();
      expect(onExtract).not.toHaveBeenCalled();

      await scheduler.pollAll(registry, { slack: { C123: { role: 'hub' } } }, onExtract);

      expect(rawStore.query('slack', new Date(0))).toHaveLength(1);
      expect(sink).toHaveBeenCalledTimes(2);
      expect(scheduler.getLastPollTime('slack')).toBeInstanceOf(Date);
      expect(onExtract).toHaveBeenCalledOnce();
    });

    it('TG-05 replays retained raw after the provider becomes unchanged', async () => {
      let pollNumber = 0;
      const connector = makeConnector('trello', []);
      connector.poll = async () => {
        pollNumber += 1;
        return pollNumber === 1
          ? [makeItem({ source: 'trello', sourceId: 'card-1', type: 'kanban_card' })]
          : [];
      };
      const registry = new ConnectorRegistry();
      registry.register('trello', connector);
      let fail = true;
      const scheduler = new PollingScheduler(rawStore, tmpDir, {
        rawIndexSink: async (connectorName, items) => {
          if (fail) {
            fail = false;
            throw new Error('forced core failure');
          }
          for (const input of mapNormalizedItemsToConnectorEventIndexInputs(connectorName, items)) {
            upsertConnectorEventIndex(getAdapter(), input);
          }
        },
      });

      await scheduler.pollAll(registry, { trello: { C123: { role: 'hub' } } }, vi.fn());
      const pending = rawStore.listPendingProjections('trello');
      expect(pending).toHaveLength(1);
      const capturedAt = pending[0]!.observedAt;
      await scheduler.pollAll(registry, { trello: { C123: { role: 'hub' } } }, vi.fn());

      expect(rawStore.listPendingProjections('trello')).toEqual([]);
      const row = getAdapter()
        .prepare(
          `SELECT o.observed_at
             FROM connector_event_index e
             JOIN observation_versions o ON o.observation_id = e.current_observation_id
            WHERE e.source_connector = 'trello' AND e.source_id = 'card-1'`
        )
        .get() as { observed_at: number };
      expect(row.observed_at).toBe(capturedAt);
      expect(pollNumber).toBe(2);
    });
  });
});
