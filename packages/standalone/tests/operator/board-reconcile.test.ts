/**
 * Unit tests for the board reconcile contract (M8 Phase 1): prompt contract +
 * scheduler debounce/max-wait/global-budget/deferral semantics. Fake timers;
 * synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildReconcilePrompt,
  ReconcileScheduler,
  RECONCILE_RUN_TOKEN,
} from '../../src/operator/board-reconcile.js';

describe('buildReconcilePrompt', () => {
  it('begins with the RECONCILE RUN mode token', () => {
    const prompt = buildReconcilePrompt({
      channelKey: 'slack:C001',
      deltaLines: ['- u1: hello'],
      todayIso: '2026-07-12',
    });
    expect(prompt.startsWith(RECONCILE_RUN_TOKEN)).toBe(true);
  });

  it('carries the obligated-action contract, dedup discipline, and scoped no-update', () => {
    const prompt = buildReconcilePrompt({
      channelKey: 'slack:C001',
      deltaLines: ['- u1: submitted v2'],
      todayIso: '2026-07-12',
    });
    expect(prompt).toContain('report_publish with ONLY the affected slots');
    expect(prompt).toContain('task_update that row instead of');
    expect(prompt).toContain('source_event_id');
    expect(prompt).toContain('contract_no_update({reason, scope: "reconcile:slack:C001"})');
    expect(prompt).toContain('RECONCILED');
    expect(prompt).toContain('<latest-delta channel="slack:C001">');
  });

  it('adds kagemusha context as CONTEXT only when enabled', () => {
    const base = buildReconcilePrompt({
      channelKey: 'kakao:room',
      deltaLines: ['x'],
      todayIso: '2026-07-12',
    });
    expect(base).not.toContain('kagemusha_tasks');
    const withCtx = buildReconcilePrompt({
      channelKey: 'kakao:room',
      deltaLines: ['x'],
      todayIso: '2026-07-12',
      kagemushaContext: true,
    });
    expect(withCtx).toContain('kagemusha_tasks() as extra CONTEXT');
    expect(withCtx).toContain('projection source');
  });
});

describe('ReconcileScheduler', () => {
  let run: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    run = vi.fn().mockResolvedValue(undefined);
    log = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(opts: Partial<ConstructorParameters<typeof ReconcileScheduler>[0]> = {}) {
    return new ReconcileScheduler({
      debounceMs: 1000,
      maxWaitMs: 3000,
      globalMaxPerHour: 2,
      run,
      log,
      ...opts,
    });
  }

  it('coalesces a burst into one run after the debounce', async () => {
    const s = make();
    s.enqueue('slack:C1', ['a']);
    s.enqueue('slack:C1', ['b']);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('slack:C1', ['a', 'b']);
    s.stop();
  });

  it('max-wait bounds a continuously-busy channel (no starvation)', async () => {
    const s = make();
    // keep re-enqueueing every 500ms; trailing debounce alone would never fire
    for (let i = 0; i < 10; i++) {
      s.enqueue('slack:C1', [`m${i}`]);
      await vi.advanceTimersByTimeAsync(500);
      if (run.mock.calls.length > 0) break;
    }
    expect(run).toHaveBeenCalledTimes(1); // fired by maxWaitMs=3000 bound
    s.stop();
  });

  it('over-budget work is DEFERRED with a log line, then retried when budget frees', async () => {
    const s = make({ globalMaxPerHour: 1, debounceMs: 10 });
    s.enqueue('slack:C1', ['a']);
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1);

    s.enqueue('chatwork:9', ['b']);
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1); // deferred, not run
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deferring chatwork:9'));
    expect(s.dirtyChannels()).toContain('chatwork:9');

    // budget window passes -> retry timer picks the dirty channel up
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith('chatwork:9', ['b']);
    s.stop();
  });

  it('run failure keeps the channel dirty and the scheduler alive', async () => {
    run.mockRejectedValueOnce(new Error('agent busy'));
    const s = make({ debounceMs: 10, globalMaxPerHour: 10 });
    s.enqueue('slack:C1', ['a']);
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('kept dirty for retry'));
    expect(s.dirtyChannels()).toContain('slack:C1');
    await vi.advanceTimersByTimeAsync(60_001); // retry timer
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('pending lines are bounded per channel', async () => {
    const s = make({ debounceMs: 10, maxPendingLines: 3 });
    s.enqueue('slack:C1', ['1', '2', '3', '4', '5']);
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledWith('slack:C1', ['3', '4', '5']);
    s.stop();
  });

  it('stop() cancels timers and blocks new work', async () => {
    const s = make();
    s.enqueue('slack:C1', ['a']);
    s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    s.enqueue('slack:C1', ['b']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });
});
