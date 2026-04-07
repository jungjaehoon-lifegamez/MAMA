import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import { RawStore } from '../../src/connectors/framework/raw-store.js';
import { classifyItemsByRole } from '../../src/memory/history-extractor.js';
import type { IConnector, NormalizedItem } from '../../src/connectors/framework/types.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function createMockConnector(name: string, items: NormalizedItem[]): IConnector {
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

describe('Connector Integration', () => {
  let tmpDir: string;
  let rawStore: RawStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'integration-'));
    rawStore = new RawStore(tmpDir);
  });

  afterEach(() => {
    try {
      rawStore.close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full flow: register → poll → raw store → classify', async () => {
    const hubItems: NormalizedItem[] = [
      {
        source: 'chatwork',
        sourceId: 'cw:1',
        channel: 'project_alpha',
        author: 'Alice',
        content: 'Task 3 assigned to Bob',
        timestamp: new Date(),
        type: 'message',
      },
    ];
    const spokeItems: NormalizedItem[] = [
      {
        source: 'kakao',
        sourceId: 'kk:1',
        channel: 'Bob',
        author: 'Bob',
        content: '3화 작업 시작합니다',
        timestamp: new Date(),
        type: 'message',
      },
    ];

    const registry = new ConnectorRegistry();
    registry.register('chatwork', createMockConnector('chatwork', hubItems));
    registry.register('kakao', createMockConnector('kakao', spokeItems));

    const channelConfigs = {
      chatwork: { project_alpha: { role: 'hub' as const } },
      kakao: { Bob: { role: 'spoke' as const } },
    };

    const collected: NormalizedItem[] = [];
    const scheduler = new PollingScheduler(rawStore, tmpDir);

    await scheduler.pollAll(registry, channelConfigs, async (classified) => {
      collected.push(...classified.activity, ...classified.spoke);
    });

    expect(collected).toHaveLength(2);

    // Classify manually to verify
    const { activity, spoke } = classifyItemsByRole(collected, channelConfigs);
    expect(activity).toHaveLength(1);
    expect(spoke).toHaveLength(1);

    // Verify raw store persistence
    const chatworkRaw = rawStore.query('chatwork', new Date(0));
    const kakaoRaw = rawStore.query('kakao', new Date(0));
    expect(chatworkRaw).toHaveLength(1);
    expect(kakaoRaw).toHaveLength(1);

    scheduler.stop();
  });

  it('handles empty poll gracefully', async () => {
    const registry = new ConnectorRegistry();
    registry.register('slack', createMockConnector('slack', []));

    const onExtract = vi.fn();
    const scheduler = new PollingScheduler(rawStore, tmpDir);

    await scheduler.pollAll(registry, {}, onExtract);

    expect(onExtract).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('deduplicates across polls', async () => {
    const items: NormalizedItem[] = [
      {
        source: 'slack',
        sourceId: 'same-id',
        channel: 'general',
        author: 'alice',
        content: 'hello',
        timestamp: new Date(),
        type: 'message',
      },
    ];

    const connector = createMockConnector('slack', items);
    const registry = new ConnectorRegistry();
    registry.register('slack', connector);

    const scheduler = new PollingScheduler(rawStore, tmpDir);

    await scheduler.pollAll(registry, {}, vi.fn());
    await scheduler.pollAll(registry, {}, vi.fn());

    // Raw store should deduplicate
    const stored = rawStore.query('slack', new Date(0));
    expect(stored).toHaveLength(1);

    scheduler.stop();
  });
});
