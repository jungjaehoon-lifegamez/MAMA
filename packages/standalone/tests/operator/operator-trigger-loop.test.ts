/**
 * Unit tests for OperatorTriggerLoop (M1-T3 - the setInterval-ticked runtime).
 * All deps injected (fake delta repo, fake memory, in-memory registry, stub agent/review)
 * so the tick pipeline is deterministic: drain -> match/fire + recordFire -> commit,
 * author on its cadence, review on its cadence. Real bindings are wired in M1-T4.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { OperatorTriggerLoop, type TickResult } from '../../src/operator/operator-trigger-loop.js';
import type {
  OperatorChannelEvent,
  OperatorMemoryPort,
} from '../../src/operator/operator-interfaces.js';
import type { CreateTriggerInput } from '../../src/operator/trigger-types.js';

function ev(id: number, channelId: string, content: string): OperatorChannelEvent {
  return {
    id,
    channel: 'slack',
    channelId,
    userId: 'u1',
    role: 'user',
    content,
    createdAt: id * 100,
  };
}

function seedTrigger(reg: TriggerRegistry, id = 'tr1', keyword = 'report'): void {
  const input: CreateTriggerInput = {
    id,
    kind: 'k',
    memoryQuery: 'weekly report cadence',
    match: { keywords: [keyword], keywordMode: 'any', minConfidence: 0.7 },
    procedure: [],
    requiredEvidence: ['current_message'],
    authoredBy: 'agent',
    provenance: { createdFrom: 'agent-authored', note: '' },
  };
  reg.create(input);
}

function fakeMem(): OperatorMemoryPort {
  return {
    async save() {},
    async recall() {
      return [{ topic: 'report-cadence', content: 'Fridays' }];
    },
  };
}

class FakeDelta {
  queue: OperatorChannelEvent[] = [];
  committed: OperatorChannelEvent[][] = [];
  drainNew(_limit: number): OperatorChannelEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  commit(events: OperatorChannelEvent[]): void {
    this.committed.push(events);
  }
}

describe('OperatorTriggerLoop', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;
  let delta: FakeDelta;
  let logs: string[];

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
    delta = new FakeDelta();
    logs = [];
  });
  afterEach(() => reg.close());

  function makeLoop(over: Partial<ConstructorParameters<typeof OperatorTriggerLoop>[0]> = {}) {
    return new OperatorTriggerLoop({
      delta,
      memory: fakeMem(),
      registry: reg,
      askAgent: async () => '[]', // author proposes nothing by default
      review: async () => ({ action: 'kept' as const }),
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 3,
        reviewEveryNTicks: 5,
        authorWindowSize: 10,
      },
      log: (line) => logs.push(line),
      ...over,
    });
  }

  it('one tick: drains, fires matching trigger, records fire, commits', async () => {
    seedTrigger(reg, 'tr1', 'report');
    delta.queue = [ev(1, 'ch-a', 'the report is late'), ev(2, 'ch-b', 'lunch at noon')];
    const loop = makeLoop();
    const result = await loop.tick();
    expect(result.drained).toBe(2);
    expect(result.fires).toBe(1);
    expect(reg.getById('tr1')?.stats.fired).toBe(1);
    expect(delta.committed).toHaveLength(1); // commit called after processing
    expect(delta.committed[0]).toHaveLength(2);
    expect(logs.some((l) => l.includes('fire'))).toBe(true);
  });

  it('author runs on its cadence with the recent-events window and persists agent specs', async () => {
    const askAgent = vi.fn(async () =>
      JSON.stringify([
        {
          kind: 'authored_by_stub',
          memoryQuery: 'q',
          match: { keywords: ['zzz'], keywordMode: 'any', minConfidence: 0.7 },
          procedure: [],
          requiredEvidence: [],
        },
      ])
    );
    const loop = makeLoop({
      askAgent,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 2,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'zzz again')];
    await loop.tick(); // tick 1: no author
    expect(askAgent).not.toHaveBeenCalled();
    delta.queue = [ev(2, 'ch-a', 'zzz more')];
    await loop.tick(); // tick 2: author fires with the buffered window
    expect(askAgent).toHaveBeenCalledTimes(1);
    expect(reg.listActive().some((t) => t.kind === 'authored_by_stub')).toBe(true);
  });

  it('review runs on its cadence only for triggers that have fired, and applies the decision', async () => {
    seedTrigger(reg, 'fired-one', 'report');
    seedTrigger(reg, 'silent-one', 'zzz');
    const review = vi.fn(async () => ({ action: 'retired' as const, reason: 'noisy' }));
    const loop = makeLoop({
      review,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 2,
        authorWindowSize: 10,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'the report is late')]; // fires 'fired-one' only
    await loop.tick();
    await loop.tick(); // review tick
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0][0].id).toBe('fired-one');
    expect(reg.getById('fired-one')?.status).toBe('disabled');
    expect(reg.getById('silent-one')?.status).toBe('active');
  });

  it('owner report: agent digest sent on cadence when fires accumulated (M1.5)', async () => {
    seedTrigger(reg, 'tr1', 'report');
    const send = vi.fn(async () => {});
    const askAgent = vi.fn(async (prompt: string) =>
      prompt.includes('digest') || prompt.includes('Fire activity') ? 'owner digest text' : '[]'
    );
    const loop = makeLoop({
      askAgent,
      output: { send },
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
        reportEveryNTicks: 2,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'the report is late')];
    await loop.tick(); // fire buffered
    const r2 = await loop.tick(); // report tick
    expect(r2.reported).toBe(true);
    expect(send).toHaveBeenCalledWith('owner digest text');
    // no activity afterwards -> no more sends
    await loop.tick();
    await loop.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('start() ticks on the interval and the returned stop fn halts it', async () => {
    vi.useFakeTimers();
    try {
      const loop = makeLoop();
      const tickSpy = vi.spyOn(loop, 'tick');
      const stop = loop.start();
      await vi.advanceTimersByTimeAsync(60_000 * 2 + 1);
      expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      const calls = tickSpy.mock.calls.length;
      stop();
      await vi.advanceTimersByTimeAsync(60_000 * 3);
      expect(tickSpy.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tick error is logged, not thrown into the interval (loop survives)', async () => {
    const loop = makeLoop();
    delta.drainNew = () => {
      throw new Error('db exploded');
    };
    await expect(loop.tick()).rejects.toThrow('db exploded'); // tick itself is honest (no-fallback)
    // start()'s interval wrapper catches + logs so the loop keeps running:
    vi.useFakeTimers();
    try {
      const stop = loop.start();
      await vi.advanceTimersByTimeAsync(60_001);
      stop();
      expect(logs.some((l) => l.includes('db exploded'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('situational digest includes the drained window (all channels), not just fires (M2)', async () => {
    seedTrigger(reg, 'tr1', 'report'); // fires on 'report'
    const send = vi.fn(async () => {});
    const captured: string[] = [];
    const askAgent = vi.fn(async (prompt: string) => {
      captured.push(prompt);
      return prompt.includes('Fire activity') ? 'digest text' : '[]';
    });
    const loop = makeLoop({
      askAgent,
      output: { send },
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
        reportEveryNTicks: 2,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'the report is late'), ev(2, 'ch-b', 'unrelated chatter')];
    await loop.tick(); // tick 1: fire on ch-a; window buffers ch-a + ch-b
    const r2 = await loop.tick(); // tick 2: digest
    expect(r2.reported).toBe(true);
    const digestPrompt = captured.find((p) => p.includes('Fire activity'))!;
    expect(digestPrompt).toContain('ch-b'); // a NON-firing channel is in the window
    expect(digestPrompt).toContain('unrelated chatter');
    expect(digestPrompt).toContain('ch-a');
  });

  it('scheduled full report: fires at a configured hour even with no trigger fires, marks the hour (M2)', async () => {
    const send = vi.fn(async () => {});
    const markFired = vi.fn();
    const markSuccess = vi.fn();
    const askAgent = vi.fn(async () => 'FULL REPORT text');
    const scheduler = {
      shouldFire: () => ({ fire: true, hourKey: '2026-07-09:08' }),
      markFired,
      loadLastSuccess: () => null,
      markSuccess,
    };
    const loop = makeLoop({
      askAgent,
      output: { send },
      reportScheduler: scheduler,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'some chatter'), ev(2, 'ch-b', 'more chatter')]; // window only, no trigger seeded
    const r = await loop.tick();
    expect(r.fires).toBe(0);
    expect(r.fullReported).toBe(true);
    expect(send).toHaveBeenCalledWith('FULL REPORT text');
    expect(markFired).toHaveBeenCalledWith('2026-07-09:08');
    // A DELIVERED report advances the delta anchor (fire-time ISO timestamp).
    expect(markSuccess).toHaveBeenCalledTimes(1);
    expect(markSuccess.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports route through the persona agent (reportAsk) while authoring stays on askAgent (M2.2)', async () => {
    seedTrigger(reg, 'tr1', 'report');
    const send = vi.fn(async () => {});
    const askAgent = vi.fn(async () => '[]'); // author/review path (bare CLI in prod)
    const reportAsk = vi.fn(async () => 'persona-composed report');
    const markFired = vi.fn();
    const scheduler = {
      shouldFire: () => ({ fire: true, hourKey: 'k' }),
      markFired,
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const loop = makeLoop({
      askAgent,
      reportAsk,
      output: { send },
      reportScheduler: scheduler,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 1,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
        reportEveryNTicks: 1,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'the report is late')];
    const r = await loop.tick();
    expect(r.reported).toBe(true);
    expect(r.fullReported).toBe(true);
    expect(reportAsk).toHaveBeenCalledTimes(2); // digest + full both on the persona path
    expect(send).toHaveBeenCalledWith('persona-composed report');
    expect(askAgent).toHaveBeenCalledTimes(1); // author pass only - never report composition
    const authorPrompt = String(askAgent.mock.calls[0][0]);
    expect(authorPrompt).toContain('TRIGGERS'); // sanity: askAgent got the authoring prompt
  });

  it('scheduled full report: fires even with ZERO activity - quiet-window aliveness (M2.1)', async () => {
    const send = vi.fn(async () => {});
    const markFired = vi.fn();
    const askAgent = vi.fn(async () => 'Scheduled report: quiet window.');
    const scheduler = {
      shouldFire: () => ({ fire: true, hourKey: '2026-07-09:13' }),
      markFired,
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const loop = makeLoop({
      askAgent,
      output: { send },
      reportScheduler: scheduler,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
    });
    // NO events drained at all - the buffer is completely empty.
    const r = await loop.tick();
    expect(r.drained).toBe(0);
    expect(r.fullReported).toBe(true);
    expect(send).toHaveBeenCalledWith('Scheduled report: quiet window.');
    expect(markFired).toHaveBeenCalledWith('2026-07-09:13');
  });

  it('scheduled full report: agent NOTHING suppresses the send but still marks the hour (fire once)', async () => {
    const send = vi.fn();
    const markFired = vi.fn();
    const markSuccess = vi.fn();
    const askAgent = vi.fn(async () => 'NOTHING');
    const scheduler = {
      shouldFire: () => ({ fire: true, hourKey: 'k' }),
      markFired,
      loadLastSuccess: () => null,
      markSuccess,
    };
    const loop = makeLoop({
      askAgent,
      output: { send },
      reportScheduler: scheduler,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'chatter')];
    const r = await loop.tick();
    expect(r.fullReported).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(markFired).toHaveBeenCalledWith('k');
    // A NOTHING-suppressed report is NOT delivered -> the anchor must not advance.
    expect(markSuccess).not.toHaveBeenCalled();
  });

  it('scheduled full report: send failure throws (no-fallback), hour NOT marked -> retries', async () => {
    const send = vi.fn(async () => {
      throw new Error('telegram down');
    });
    const markFired = vi.fn();
    const markSuccess = vi.fn();
    const askAgent = vi.fn(async () => 'FULL');
    const scheduler = {
      shouldFire: () => ({ fire: true, hourKey: 'k' }),
      markFired,
      loadLastSuccess: () => null,
      markSuccess,
    };
    const loop = makeLoop({
      askAgent,
      output: { send },
      reportScheduler: scheduler,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'chatter')];
    await expect(loop.tick()).rejects.toThrow('telegram down');
    expect(markFired).not.toHaveBeenCalled();
    // Send threw before markFired/markSuccess -> the anchor never advances (retry next cadence).
    expect(markSuccess).not.toHaveBeenCalled();
  });

  it('scheduled full report: not a configured hour -> no send, no mark', async () => {
    const send = vi.fn();
    const markFired = vi.fn();
    const scheduler = {
      shouldFire: () => ({ fire: false, hourKey: 'k' }),
      markFired,
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const loop = makeLoop({
      output: { send },
      reportScheduler: scheduler,
      config: {
        tickMs: 1000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
    });
    delta.queue = [ev(1, 'ch-a', 'chatter')];
    const r = await loop.tick();
    expect(r.fullReported).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
  });

  it('nudge(): schedules ONE debounced tick; a burst collapses to a single tick (M2.4)', async () => {
    vi.useFakeTimers();
    try {
      const loop = makeLoop({
        config: {
          tickMs: 60_000,
          drainLimit: 50,
          authorEveryNTicks: 99,
          reviewEveryNTicks: 99,
          authorWindowSize: 10,
          nudgeDebounceMs: 15_000,
        },
      });
      const tickSpy = vi.spyOn(loop, 'tick');
      loop.nudge();
      loop.nudge();
      loop.nudge(); // burst - one armed timer only
      expect(tickSpy).not.toHaveBeenCalled(); // debounced: nothing yet
      await vi.advanceTimersByTimeAsync(15_000);
      expect(tickSpy).toHaveBeenCalledTimes(1); // burst collapsed to a single tick
    } finally {
      vi.useRealTimers();
    }
  });

  it('nudge(): after the debounced tick fires, a later nudge arms a fresh tick (M2.4)', async () => {
    vi.useFakeTimers();
    try {
      const loop = makeLoop({
        config: {
          tickMs: 60_000,
          drainLimit: 50,
          authorEveryNTicks: 99,
          reviewEveryNTicks: 99,
          authorWindowSize: 10,
          nudgeDebounceMs: 15_000,
        },
      });
      const tickSpy = vi.spyOn(loop, 'tick');
      loop.nudge();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(tickSpy).toHaveBeenCalledTimes(1);
      loop.nudge(); // fresh quiet window
      await vi.advanceTimersByTimeAsync(15_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nudge(): skips when the previous tick is still running - never concurrent (M2.4)', async () => {
    vi.useFakeTimers();
    try {
      const loop = makeLoop({
        config: {
          tickMs: 60_000,
          drainLimit: 50,
          authorEveryNTicks: 99,
          reviewEveryNTicks: 99,
          authorWindowSize: 10,
          nudgeDebounceMs: 5_000,
        },
      });
      // First nudge-driven tick hangs, so `running` stays true across the second nudge window.
      let resolveFirst: () => void = () => {};
      const firstTick = new Promise<TickResult>((res) => {
        resolveFirst = () =>
          res({
            tick: 1,
            drained: 0,
            fires: 0,
            authored: 0,
            reviewed: 0,
            reported: false,
            fullReported: false,
          });
      });
      const tickSpy = vi.spyOn(loop, 'tick').mockReturnValueOnce(firstTick);
      loop.nudge();
      await vi.advanceTimersByTimeAsync(5_000); // first debounced tick starts and hangs -> running=true
      expect(tickSpy).toHaveBeenCalledTimes(1);
      loop.nudge(); // arm a second nudge while the first tick is still in flight
      await vi.advanceTimersByTimeAsync(5_000); // timer fires but running===true -> must skip
      expect(tickSpy).toHaveBeenCalledTimes(1); // NOT called a second time
      expect(logs.some((l) => l.includes('nudge') && l.includes('already running'))).toBe(true);
      resolveFirst();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the returned stop fn cancels a pending nudge (no tick after stop) (M2.4)', async () => {
    vi.useFakeTimers();
    try {
      const loop = makeLoop({
        config: {
          tickMs: 60_000,
          drainLimit: 50,
          authorEveryNTicks: 99,
          reviewEveryNTicks: 99,
          authorWindowSize: 10,
          nudgeDebounceMs: 15_000,
        },
      });
      const tickSpy = vi.spyOn(loop, 'tick');
      const stop = loop.start(); // interval at 60s
      loop.nudge(); // arm nudge at +15s
      stop(); // must clear both the interval AND the pending nudge
      await vi.advanceTimersByTimeAsync(15_000 + 60_000);
      expect(tickSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('nudge forwarder pattern: no-ops before the loop is bound, wakes it after (M2.4 wiring)', async () => {
    vi.useFakeTimers();
    try {
      // Mirror start.ts: a stable forwarder is handed to the connector sink BEFORE the loop exists.
      const triggerLoopNudge: { current: (() => void) | null } = { current: null };
      const forward = () => triggerLoopNudge.current?.();
      forward(); // the initial poll's sink fires before the loop is constructed -> safe no-op
      const loop = makeLoop({
        config: {
          tickMs: 60_000,
          drainLimit: 50,
          authorEveryNTicks: 99,
          reviewEveryNTicks: 99,
          authorWindowSize: 10,
          nudgeDebounceMs: 15_000,
        },
      });
      const tickSpy = vi.spyOn(loop, 'tick');
      triggerLoopNudge.current = () => loop.nudge(); // gated block binds it after start()
      forward(); // a later poll batch -> reaches loop.nudge()
      await vi.advanceTimersByTimeAsync(15_000);
      expect(tickSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
