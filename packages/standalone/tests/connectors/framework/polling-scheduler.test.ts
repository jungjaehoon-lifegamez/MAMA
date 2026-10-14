import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorRegistry } from '../../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../../src/connectors/framework/polling-scheduler.js';
import { RawStore } from '../../../src/storage/source-archive.js';
import type { IConnector } from '../../../src/connectors/framework/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeConnector(
  items: IConnector['poll'] extends (since: Date) => Promise<infer R> ? R : never
): IConnector {
  return {
    name: 'slack',
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
  it.each(['pollConnector', 'pollAll'] as const)(
    'awaits the in-flight %s outcome before stop returns and refuses new polls',
    async (method) => {
      const root = mkdtempSync(join(tmpdir(), 'poll-stop-'));
      roots.push(root);
      const raw = new RawStore(root);
      let finish!: () => void;
      const connector = fakeConnector([]);
      connector.poll = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () => resolve([]);
          })
      );
      const outcomes = vi.fn();
      const scheduler = new PollingScheduler(raw, root, { recordPollOutcome: outcomes });
      const registry = new ConnectorRegistry();
      registry.register('slack', connector);
      const poll =
        method === 'pollAll'
          ? scheduler.pollAll(registry, {}, async () => {})
          : scheduler.pollConnector('slack', registry, {}, async () => {});
      await vi.waitFor(() => expect(connector.poll).toHaveBeenCalledOnce());
      let closed = false;
      const stop = Promise.resolve(scheduler.stop()).then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(closed).toBe(false);
        finish();
        await poll;
        await stop;
        expect(outcomes).toHaveBeenCalledOnce();
        await scheduler.pollAll(registry, {}, async () => {});
        await scheduler.pollConnector('slack', registry, {}, async () => {});
        expect(connector.poll).toHaveBeenCalledOnce();
      } finally {
        finish();
        await poll;
        await stop;
        raw.close();
      }
    }
  );
  it('logs poll failures while leaving the source cursor unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-error-'));
    roots.push(root);
    const raw = new RawStore(root);
    const scheduler = new PollingScheduler(raw, root, { rawIndexSink: () => [] });
    const registry = new ConnectorRegistry();
    const failed = fakeConnector([]);
    const failure = new Error('source unavailable');
    failed.poll = async () => {
      throw failure;
    };
    registry.register('slack', failed);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await scheduler.pollAll(registry, {}, async () => {});
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('slack'), failure);
      expect(scheduler.getLastPollTime('slack')).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it.each(['pollConnector', 'pollAll'] as const)(
    'logs state persistence errors from %s without an unhandled rejection',
    async (method) => {
      const root = mkdtempSync(join(tmpdir(), 'poll-state-error-'));
      roots.push(root);
      const blocked = join(root, 'blocked');
      writeFileSync(blocked, 'not a directory');
      const raw = new RawStore(join(root, 'raw'));
      const scheduler = new PollingScheduler(raw, blocked, { rawIndexSink: () => [] });
      const registry = new ConnectorRegistry();
      registry.register('slack', fakeConnector([]));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const poll =
          method === 'pollAll'
            ? scheduler.pollAll(registry, {}, async () => {})
            : scheduler.pollConnector('slack', registry, {}, async () => {});
        await expect(poll).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('poll'), expect.any(Error));
      } finally {
        raw.close();
      }
    }
  );

  it('runs raw save, index projection, and source-delta handoff in order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const order: string[] = [];
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
      rawIndexSink: async (_connector, items) => {
        order.push('index');
        return items.map((item) => ({
          sourceId: item.sourceId,
          observationRef: `obs:${item.sourceId}`,
        }));
      },
    });
    const registry = new ConnectorRegistry();
    const connector = fakeConnector([
      {
        source: 'slack',
        sourceId: 'source-key',
        channel: 'display-room',
        author: 'actor-key',
        content: 'source-content',
        timestamp: new Date('2024-01-01T12:00:00.000Z'),
        type: 'message',
      },
    ]);
    registry.register('slack', connector);
    await scheduler.pollAll(
      registry,
      { slack: { 'channel-key': { role: 'hub', name: 'display-room' } } },
      async (delta) => {
        order.push('delta');
        expect(delta).toMatchObject({
          collector: 'slack',
          channel: 'channel-key',
          coalesceKey: 'source:slack:channel-key',
        });
        expect(delta.refs).toHaveLength(1);
      }
    );
    expect(order).toEqual(['index', 'delta']);
    expect(scheduler.getLastPollTime('slack')?.toISOString()).toBe('2024-01-02T00:00:00.000Z');
    expect(rawStore.query('slack', new Date(0))[0]?.channel).toBe('channel-key');
    rawStore.close();
  });

  it('admits one source delta when the same observation is returned on consecutive polls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-unchanged-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
      rawIndexSink: (_connector, items) =>
        items.map((item) => ({ sourceId: item.sourceId, observationRef: `obs:${item.sourceId}` })),
    });
    const registry = new ConnectorRegistry();
    let sourceCursor = Date.parse('2024-01-01T00:00:00.000Z');
    const connector = fakeConnector([]);
    connector.poll = vi.fn(async () => {
      sourceCursor += 1_000;
      return [
        {
          source: 'slack',
          sourceId: 'source-key',
          channel: 'channel-key',
          author: 'actor-key',
          content: 'unchanged source content',
          timestamp: new Date('2024-01-01T12:00:00.000Z'),
          type: 'message',
          sourceCursor: new Date(sourceCursor).toISOString(),
          metadata: { observedAt: new Date(sourceCursor).toISOString() },
        },
      ];
    });
    registry.register('slack', connector);
    const admitted = vi.fn();

    await scheduler.pollConnector(
      'slack',
      registry,
      { slack: { 'channel-key': { role: 'hub' } } },
      admitted
    );
    await scheduler.pollConnector(
      'slack',
      registry,
      { slack: { 'channel-key': { role: 'hub' } } },
      admitted
    );

    expect(connector.poll).toHaveBeenCalledTimes(2);
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(admitted.mock.calls[0]?.[0].refs).toHaveLength(1);
    expect(rawStore.listPendingProjections('slack')).toEqual([]);
    rawStore.close();
  });

  it('keeps the request start as the next cursor so changes during collection are queried again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-cursor-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    let clock = 10_000;
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => clock,
      initialNow: clock,
      rawIndexSink: () => [],
    });
    const registry = new ConnectorRegistry();
    const connector = fakeConnector([]);
    connector.poll = vi.fn(async () => {
      clock = 20_000;
      return [];
    });
    registry.register('slack', connector);

    await scheduler.pollConnector('slack', registry, {}, async () => {});

    expect(scheduler.getLastPollTime('slack')).toEqual(new Date(10_000));
    rawStore.close();
  });

  it('does not advance state when the handoff fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-fail-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => 10_000,
      rawIndexSink: (_connector, items) =>
        items.map((item) => ({ sourceId: item.sourceId, observationRef: `obs:${item.sourceId}` })),
    });
    const registry = new ConnectorRegistry();
    registry.register(
      'slack',
      fakeConnector([
        {
          source: 'slack',
          sourceId: 'source-key',
          channel: 'channel-key',
          author: 'actor-key',
          content: 'source-content',
          timestamp: new Date(1),
          type: 'message',
        },
      ])
    );
    await scheduler.pollAll(registry, { slack: { 'channel-key': { role: 'hub' } } }, async () => {
      throw new Error('handoff failed');
    });
    expect(scheduler.getLastPollTime('slack')).toBeUndefined();
    expect(rawStore.listPendingProjections('slack')).toHaveLength(1);
    rawStore.close();
  });

  it('hands off every pending projection when one poll returns more than one page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-page-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const scheduler = new PollingScheduler(rawStore, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
      rawIndexSink: (_connector, items) =>
        items.map((item) => ({ sourceId: item.sourceId, observationRef: `obs:${item.sourceId}` })),
    });
    const registry = new ConnectorRegistry();
    const items = Array.from({ length: 1001 }, (_, index) => ({
      source: 'slack',
      sourceId: `source-${index}`,
      channel: 'channel-key',
      author: 'actor-key',
      content: `source-content-${index}`,
      timestamp: new Date(1_000 + index),
      type: 'message' as const,
    }));
    registry.register('slack', fakeConnector(items));
    let refs = 0;
    await scheduler.pollAll(
      registry,
      { slack: { 'channel-key': { role: 'hub' } } },
      async (delta) => {
        refs += delta.refs.length;
      }
    );
    expect(refs).toBe(1001);
    rawStore.close();
  });

  it('does not overlap a connector interval with an active poll', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-scheduler-overlap-'));
    roots.push(root);
    const rawStore = new RawStore(root);
    const scheduler = new PollingScheduler(rawStore, root, {
      rawIndexSink: (_connector, items) =>
        items.map((item) => ({ sourceId: item.sourceId, observationRef: `obs:${item.sourceId}` })),
    });
    const registry = new ConnectorRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = fakeConnector([]);
    (connector.poll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await gate;
      return [];
    });
    registry.register('slack', connector);
    const first = scheduler.pollConnector('slack', registry, { slack: {} }, vi.fn());
    await Promise.resolve();
    const second = scheduler.pollConnector('slack', registry, { slack: {} }, vi.fn());
    expect(connector.poll).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    rawStore.close();
  });
});
