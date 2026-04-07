import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorRegistry } from '../../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../../src/connectors/framework/polling-scheduler.js';
import { RawStore } from '../../../src/connectors/framework/raw-store.js';
import type { IConnector, NormalizedItem } from '../../../src/connectors/framework/types.js';

function makeItem(sourceId: string, timestamp: Date): NormalizedItem {
  return {
    source: 'test',
    sourceId,
    channel: 'general',
    author: 'bot',
    content: 'test content',
    timestamp,
    type: 'message',
  };
}

function makeMockConnector(name: string, items: NormalizedItem[] = []): IConnector {
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

describe('PollingScheduler', () => {
  let tmpDir: string;
  let rawStore: RawStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'poll-sched-test-'));
    rawStore = new RawStore(tmpDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    // rawStore may have been closed by scheduler.stop(), so guard
    try {
      rawStore.close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('pollAll (batch mode)', () => {
    it('collects from all connectors and calls batch callback', async () => {
      const onExtract = vi.fn().mockResolvedValue(undefined);
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const slackItem = makeItem('slack-1', new Date('2026-04-07T10:00:00Z'));
      slackItem.source = 'slack';
      slackItem.channel = 'general';
      const notionItem = makeItem('notion-1', new Date('2026-04-07T11:00:00Z'));
      notionItem.source = 'notion';
      notionItem.channel = 'tasks';

      const slackConnector = makeMockConnector('slack', [slackItem]);
      const notionConnector = makeMockConnector('notion', [notionItem]);
      registry.register('slack', slackConnector);
      registry.register('notion', notionConnector);

      const channelConfigs = {
        slack: { general: { role: 'hub' as const } },
        notion: { tasks: { role: 'hub' as const } },
      };

      await scheduler.pollAll(registry, channelConfigs, onExtract);

      expect(onExtract).toHaveBeenCalledOnce();
      const classified = onExtract.mock.calls[0]?.[0] as {
        truth: unknown[];
        activity: unknown[];
        spoke: unknown[];
      };
      expect(classified.activity).toHaveLength(2);
      expect(classified.truth).toHaveLength(0);
      expect(classified.spoke).toHaveLength(0);
    });

    it('skips callback when no items from any connector', async () => {
      const onExtract = vi.fn().mockResolvedValue(undefined);
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const slackConnector = makeMockConnector('slack', []);
      const notionConnector = makeMockConnector('notion', []);
      registry.register('slack', slackConnector);
      registry.register('notion', notionConnector);

      await scheduler.pollAll(registry, {}, onExtract);

      expect(onExtract).not.toHaveBeenCalled();
    });

    it('saves all items to raw store', async () => {
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const ts = new Date('2026-04-07T10:00:00Z');
      const slackItem = makeItem('slack-stored', ts);
      slackItem.source = 'slack';
      slackItem.channel = 'general';
      const notionItem = makeItem('notion-stored', ts);
      notionItem.source = 'notion';
      notionItem.channel = 'tasks';

      registry.register('slack', makeMockConnector('slack', [slackItem]));
      registry.register('notion', makeMockConnector('notion', [notionItem]));

      await scheduler.pollAll(registry, {}, vi.fn());

      const slackItems = rawStore.query('slack', new Date(0));
      const notionItems = rawStore.query('notion', new Date(0));
      expect(slackItems).toHaveLength(1);
      expect(notionItems).toHaveLength(1);
      expect(slackItems[0]?.sourceId).toBe('slack-stored');
      expect(notionItems[0]?.sourceId).toBe('notion-stored');
    });

    it('startBatch fires initial poll and sets interval', async () => {
      const onBatchExtract = vi.fn().mockResolvedValue(undefined);
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const item1 = makeItem('batch-1', new Date());
      item1.source = 'slack';
      item1.channel = 'general';
      const item2 = makeItem('batch-2', new Date());
      item2.source = 'slack';
      item2.channel = 'general';

      // First poll returns item1, second poll returns item2 (new item to avoid dedup)
      const connector = makeMockConnector('slack', [item1]);
      (connector.poll as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([item1])
        .mockResolvedValueOnce([item2]);
      registry.register('slack', connector);

      const channelConfigs = { slack: { general: { role: 'hub' as const } } };

      scheduler.startBatch(registry, channelConfigs, 1, onBatchExtract);

      // Allow the initial fire-and-forget poll to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(onBatchExtract).toHaveBeenCalledOnce();

      // Advance 1 minute — should trigger another batch poll with new item
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(onBatchExtract.mock.calls.length).toBeGreaterThan(1);

      scheduler.stop();
    });

    it('stop() clears the batch timer', async () => {
      const onBatchExtract = vi.fn().mockResolvedValue(undefined);
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const item = makeItem('batch-stop', new Date());
      item.source = 'slack';
      item.channel = 'general';
      // Return different items each time to avoid dedup filter
      let callCount = 0;
      const connector = makeMockConnector('slack', [item]);
      (connector.poll as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const newItem = makeItem(`batch-stop-${callCount}`, new Date());
        newItem.source = 'slack';
        newItem.channel = 'general';
        return Promise.resolve([newItem]);
      });
      registry.register('slack', connector);

      const channelConfigs = { slack: { general: { role: 'hub' as const } } };

      scheduler.startBatch(registry, channelConfigs, 1, onBatchExtract);
      await vi.advanceTimersByTimeAsync(0);

      scheduler.stop();
      const callsAtStop = onBatchExtract.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // advance 5 minutes
      expect(onBatchExtract.mock.calls.length).toBe(callsAtStop);
    });
  });

  describe('retry on poll failure', () => {
    it('retries up to 3 times on poll error', async () => {
      vi.useRealTimers();
      const rawStore2 = new RawStore(tmpDir);
      const scheduler = new PollingScheduler(rawStore2, tmpDir);
      const registry = new ConnectorRegistry();

      const failConnector = makeMockConnector('flaky', []);
      (failConnector.poll as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce([]);
      registry.register('flaky', failConnector);

      await scheduler.pollAll(registry, {}, vi.fn());

      expect(failConnector.poll).toHaveBeenCalledTimes(3);
      // Should have advanced the cursor (successful on 3rd attempt)
      expect(scheduler.getLastPollTime('flaky')).toBeDefined();

      rawStore2.close();
      vi.useFakeTimers();
    }, 15000);

    it('gives up after 3 failures', async () => {
      vi.useRealTimers();
      const rawStore2 = new RawStore(tmpDir);
      const scheduler = new PollingScheduler(rawStore2, tmpDir);
      const registry = new ConnectorRegistry();

      const failConnector = makeMockConnector('broken', []);
      (failConnector.poll as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('permanent_error')
      );
      registry.register('broken', failConnector);

      await scheduler.pollAll(registry, {}, vi.fn());

      expect(failConnector.poll).toHaveBeenCalledTimes(3);
      // Should NOT have advanced cursor
      expect(scheduler.getLastPollTime('broken')).toBeUndefined();

      rawStore2.close();
      vi.useFakeTimers();
    }, 15000);
  });

  describe('extraction dedup', () => {
    it('skips extraction for already-extracted items on second poll', async () => {
      const onExtract = vi.fn().mockResolvedValue(undefined);
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const item = makeItem('dedup-1', new Date('2026-04-07T10:00:00Z'));
      item.source = 'slack';
      item.channel = 'general';
      const connector = makeMockConnector('slack', [item]);
      registry.register('slack', connector);

      const channelConfigs = { slack: { general: { role: 'hub' as const } } };

      // First poll — should extract
      await scheduler.pollAll(registry, channelConfigs, onExtract);
      expect(onExtract).toHaveBeenCalledOnce();

      // Second poll with same items — should skip extraction
      await scheduler.pollAll(registry, channelConfigs, onExtract);
      // onExtract should still be called only once (no new items to extract)
      expect(onExtract).toHaveBeenCalledOnce();
    });
  });

  describe('state persistence', () => {
    it('writes poll-state.json after pollAll', async () => {
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const item = makeItem('state-msg', new Date());
      item.source = 'slack';
      item.channel = 'general';
      registry.register('slack', makeMockConnector('slack', [item]));

      await scheduler.pollAll(registry, {}, vi.fn());

      const stateFile = join(tmpDir, 'poll-state.json');
      expect(existsSync(stateFile)).toBe(true);

      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, string>;
      expect(state['slack']).toBeDefined();
      expect(new Date(state['slack']!)).toBeInstanceOf(Date);
    });

    it('restores lastPollTime from poll-state.json on construction', async () => {
      const scheduler1 = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const item = makeItem('persist-msg', new Date());
      item.source = 'slack';
      item.channel = 'general';
      registry.register('slack', makeMockConnector('slack', [item]));

      await scheduler1.pollAll(registry, {}, vi.fn());
      const savedTime = scheduler1.getLastPollTime('slack');

      // Second scheduler reads it back (need a new rawStore since stop closes it)
      const rawStore2 = new RawStore(tmpDir);
      const scheduler2 = new PollingScheduler(rawStore2, tmpDir);
      const restoredTime = scheduler2.getLastPollTime('slack');

      expect(restoredTime).toBeDefined();
      expect(restoredTime!.getTime()).toBe(savedTime!.getTime());
      rawStore2.close();
    });
  });

  describe('getLastPollTime', () => {
    it('returns undefined before first poll', () => {
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      expect(scheduler.getLastPollTime('unknown')).toBeUndefined();
    });

    it('returns a Date after polling', async () => {
      const scheduler = new PollingScheduler(rawStore, tmpDir);
      const registry = new ConnectorRegistry();

      const item = makeItem('time-msg', new Date());
      item.source = 'slack';
      item.channel = 'general';
      registry.register('slack', makeMockConnector('slack', [item]));

      await scheduler.pollAll(registry, {}, vi.fn());

      expect(scheduler.getLastPollTime('slack')).toBeInstanceOf(Date);
    });
  });
});
