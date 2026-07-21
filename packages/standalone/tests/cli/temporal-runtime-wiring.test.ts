import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleDaemonTemporalRuntime } from '../../src/cli/runtime/temporal-init.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { WorkOrderConsumer } from '../../src/operator/workorder-consumer.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';

describe('Story A2 Task 14: production temporal daemon composition', () => {
  let db: SQLiteDatabase;
  const now = Date.parse('2026-07-21T15:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('registers the real hook and recovers before scanning and consumer start', async () => {
    const ledger = new TaskLedger(db, { now: () => now, timeZone: 'Asia/Seoul' });
    ledger.create({ title: 'due owner task', due_at: '2026-07-22T00:00:00+09:00' });
    const consumer = new WorkOrderConsumer({
      ledger,
      runner: { runWithContent: async () => ({ response: 'unused' }) },
      loadBrief: () => 'unused',
      noticeOwner: () => {},
      opsAlarm: { configured: false, send: async () => {} },
      now: () => now,
    });
    const order: string[] = [];
    const registerHook = vi.spyOn(consumer, 'registerHook');
    const originalRecover = consumer.bootRecover.bind(consumer);
    vi.spyOn(consumer, 'bootRecover').mockImplementation(() => {
      order.push('recover');
      originalRecover();
    });
    const originalScan = ledger.listTemporalScanPage.bind(ledger);
    vi.spyOn(ledger, 'listTemporalScanPage').mockImplementation((input) => {
      order.push('scan');
      return originalScan(input);
    });
    const originalStart = consumer.start.bind(consumer);
    vi.spyOn(consumer, 'start').mockImplementation(() => {
      order.push('consumer-start');
      originalStart();
    });

    const assembly = assembleDaemonTemporalRuntime({
      flag: 'on',
      stage2Flag: 'on',
      backend: 'codex',
      envelopeIssuanceMode: 'enabled',
      effectiveTools: ['task_temporal_reconcile'],
      availableTools: ['task_temporal_reconcile'],
      transportReady: true,
      timeZone: 'Asia/Seoul',
      ledger,
      consumer,
      now: () => now,
    });

    expect(registerHook).toHaveBeenCalledOnce();
    expect(registerHook.mock.calls[0]).toMatchObject(['temporal', { verdictRequired: true }]);
    expect(assembly.bootAfterRoutes()).toMatchObject({ enabled: true, enqueued: 1 });
    expect(order).toEqual(['recover', 'scan', 'consumer-start']);
    expect(consumer.isStarted()).toBe(true);
    expect(vi.getTimerCount()).toBe(2);

    await assembly.runtime.stop();
    expect(consumer.isStarted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
