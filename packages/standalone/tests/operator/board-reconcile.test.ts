/**
 * Unit tests for the board reconcile contract (M8 Phase 1): prompt contract +
 * scheduler debounce/max-wait/global-budget/deferral semantics. Fake timers;
 * synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconcileScheduler } from '../../src/operator/board-reconcile.js';

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
    expect(run).toHaveBeenCalledWith('slack:C1', ['a', 'b'], [], 0);
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
    expect(run).toHaveBeenLastCalledWith('chatwork:9', ['b'], [], 0);
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
    expect(run).toHaveBeenCalledWith('slack:C1', ['3', '4', '5'], [], 0);
    s.stop();
  });

  it('TG-01 carries the newest captured repair generation through one scheduler fire', async () => {
    const s = make({ debounceMs: 10 });
    s.enqueue('telegram:owner', ['older'], ['evt-1'], 41);
    s.enqueue('telegram:owner', ['newer'], ['evt-2'], 42);

    await vi.advanceTimersByTimeAsync(20);

    expect(run).toHaveBeenCalledWith('telegram:owner', ['older', 'newer'], ['evt-1', 'evt-2'], 42);
    s.stop();
  });

  it('TG-06 preserves the captured generation when enqueue fails and the batch retries', async () => {
    run.mockRejectedValueOnce(new Error('enqueue failed'));
    const s = make({ debounceMs: 10, globalMaxPerHour: 10 });
    s.enqueue('slack:C1', ['delta'], ['evt-1'], 77);

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(60_001);

    expect(run).toHaveBeenNthCalledWith(1, 'slack:C1', ['delta'], ['evt-1'], 77);
    expect(run).toHaveBeenNthCalledWith(2, 'slack:C1', ['delta'], ['evt-1'], 77);
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
