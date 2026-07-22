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
import type { PendingReportState } from '../../src/operator/pending-report-store.js';

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

  it('persists the report window before cursor commit and delivers it after restart', async () => {
    let pending: PendingReportState | null = null;
    const order: string[] = [];
    const pendingReportStore = {
      load: () => pending,
      save: (state: PendingReportState) => {
        order.push('save');
        pending = structuredClone(state);
      },
    };
    const originalCommit = delta.commit.bind(delta);
    delta.commit = (events) => {
      order.push('commit');
      originalCommit(events);
    };
    delta.queue = [ev(1, 'owner', 'restart-safe update')];

    await makeLoop({ pendingReportStore, output: { send: vi.fn(async () => {}) } }).tick();

    expect(order.slice(0, 2)).toEqual(['save', 'commit']);
    const send = vi.fn(async () => {});
    const recovered = makeLoop({
      pendingReportStore,
      output: { send },
      reportAsk: async () => 'recovered owner report',
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
        reportEveryNTicks: 1,
      },
    });

    await recovered.tick();

    expect(send).toHaveBeenCalledWith(
      'recovered owner report',
      expect.stringMatching(/^operator-report:digest:/)
    );
    expect(pending?.digest.windowTotal).toBe(0);
  });

  it('still forwards replayed connector events to board reconciliation after report dedupe', async () => {
    let pending: PendingReportState | null = null;
    const pendingReportStore = {
      load: () => pending,
      save: (state: PendingReportState) => {
        pending = structuredClone(state);
      },
    };
    const event = ev(1, 'owner', 'board delta that must survive restart');
    delta.queue = [event];

    await makeLoop({ pendingReportStore, output: { send: vi.fn(async () => {}) } }).tick();

    delta.queue = [event];
    const onChannelDelta = vi.fn();
    await makeLoop({
      pendingReportStore,
      output: { send: vi.fn(async () => {}) },
      onChannelDelta,
    }).tick();

    expect(onChannelDelta).toHaveBeenCalledOnce();
    expect(onChannelDelta).toHaveBeenCalledWith(
      'slack:owner',
      expect.arrayContaining([expect.stringContaining('board delta that must survive restart')])
    );
    expect(pending?.digest.windowTotal).toBe(1);
  });

  it('does not retain connector excerpts when no owner-report sink is configured', async () => {
    const pendingReportStore = {
      load: vi.fn(() => null),
      save: vi.fn(),
    };
    delta.queue = [ev(1, 'private-channel', 'private connector excerpt')];

    await makeLoop({ pendingReportStore }).tick();

    expect(pendingReportStore.load).not.toHaveBeenCalled();
    expect(pendingReportStore.save).not.toHaveBeenCalled();
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
    expect(send).toHaveBeenCalledWith(
      'owner digest text',
      expect.stringMatching(/^operator-report:digest:/)
    );
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
    expect(send).toHaveBeenCalledWith(
      'FULL REPORT text',
      'operator-report:scheduled:2026-07-09:08'
    );
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
    expect(send).toHaveBeenCalledWith(
      'persona-composed report',
      expect.stringMatching(/^operator-report:/)
    );
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
    expect(send).toHaveBeenCalledWith(
      'Scheduled report: quiet window.',
      'operator-report:scheduled:2026-07-09:13'
    );
    expect(markFired).toHaveBeenCalledWith('2026-07-09:13');
  });

  it('scheduled full report: agent NOTHING is retryable and does not consume the hour', async () => {
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
    await expect(loop.tick()).rejects.toThrow('Full owner report returned no content');
    expect(send).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
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

describe('Story OPS-1 / S1-T3: on-demand full report + scheduled suppression', () => {
  function fakeScheduler(
    overrides: Partial<{
      fire: boolean;
      hourKey: string;
      lastSuccess: string | null;
    }> = {}
  ) {
    const state = {
      fired: [] as string[],
      success: [] as string[],
    };
    return {
      state,
      shouldFire: () => ({
        fire: overrides.fire ?? false,
        hourKey: overrides.hourKey ?? '2026-07-17:13',
      }),
      markFired: (hourKey: string) => {
        state.fired.push(hourKey);
      },
      loadLastSuccess: () => overrides.lastSuccess ?? null,
      markSuccess: (iso: string) => {
        state.success.push(iso);
      },
    };
  }

  function makeLoopWith(over: Record<string, unknown>, logs: string[]) {
    const delta = new FakeDelta();
    const reg = new TriggerRegistry(new Database(':memory:'));
    return new OperatorTriggerLoop({
      delta,
      memory: fakeMem(),
      registry: reg,
      askAgent: async () => '[]',
      review: async () => ({ action: 'kept' as const }),
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 3,
        reviewEveryNTicks: 5,
        authorWindowSize: 10,
      },
      log: (line: string) => logs.push(line),
      ...over,
    });
  }

  describe('AC #1: startFullReport routes through the real machinery', () => {
    it('sends, consumes the hour, and advances the anchor on success', async () => {
      const logs: string[] = [];
      const scheduler = fakeScheduler({ hourKey: '2026-07-17:14' });
      const sent: string[] = [];
      const loop = makeLoopWith(
        {
          reportScheduler: scheduler,
          output: {
            send: async (text: string) => {
              sent.push(text);
            },
          },
          reportAsk: async () => 'on-demand situation summary\nUSED_TRIGGERS: none',
        },
        logs
      );

      const started = loop.startFullReport();
      expect(started.accepted).toBe(true);
      await vi.waitFor(() => {
        expect(sent.length).toBe(1);
      });
      await vi.waitFor(() => {
        expect(scheduler.state.fired).toEqual(['2026-07-17:14']);
        expect(scheduler.state.success.length).toBe(1);
      });
      expect(logs.join('\n')).toContain('on-demand full report SENT');
    });

    it('reports busy while another run holds the loop and unavailable without a sink', () => {
      const logs: string[] = [];
      const noSink = makeLoopWith({}, logs);
      expect(noSink.startFullReport()).toEqual({ accepted: false, reason: 'unavailable' });

      const scheduler = fakeScheduler();
      const withSink = makeLoopWith(
        {
          reportScheduler: scheduler,
          output: { send: async () => {} },
          reportAsk: () => new Promise<string>(() => {}), // parks forever
        },
        logs
      );
      expect(withSink.startFullReport().accepted).toBe(true);
      expect(withSink.startFullReport()).toEqual({ accepted: false, reason: 'busy' });
    });
  });

  describe('AC #2: scheduled fire is suppressed-and-consumed inside the min interval', () => {
    it('skips the scheduled run when the last success is fresh', async () => {
      const logs: string[] = [];
      const recentIso = new Date(Date.now() - 5 * 60_000).toISOString();
      const scheduler = fakeScheduler({
        fire: true,
        hourKey: '2026-07-17:13',
        lastSuccess: recentIso,
      });
      const sent: string[] = [];
      const loop = makeLoopWith(
        {
          reportScheduler: scheduler,
          output: {
            send: async (text: string) => {
              sent.push(text);
            },
          },
          reportAsk: async () => 'should not be called for the scheduled leg',
        },
        logs
      );

      await loop.tick();
      expect(scheduler.state.fired).toEqual(['2026-07-17:13']);
      expect(scheduler.state.success).toEqual([]);
      expect(sent).toEqual([]);
      expect(logs.join('\n')).toContain('full report skipped - last success');
    });

    it('fires normally when the last success is stale', async () => {
      const logs: string[] = [];
      const staleIso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const scheduler = fakeScheduler({
        fire: true,
        hourKey: '2026-07-17:13',
        lastSuccess: staleIso,
      });
      const sent: string[] = [];
      const loop = makeLoopWith(
        {
          reportScheduler: scheduler,
          output: {
            send: async (text: string) => {
              sent.push(text);
            },
          },
          reportAsk: async () => 'scheduled situation summary\nUSED_TRIGGERS: none',
        },
        logs
      );

      await loop.tick();
      expect(sent.length).toBe(1);
      expect(scheduler.state.fired).toEqual(['2026-07-17:13']);
      expect(scheduler.state.success.length).toBe(1);
    });
  });
});

describe('TG-06: durable owner-report delivery identity', () => {
  function durableLoop(
    pendingRef: { current: PendingReportState | null },
    over: Partial<ConstructorParameters<typeof OperatorTriggerLoop>[0]> = {}
  ): OperatorTriggerLoop {
    const localDb = new Database(':memory:');
    const localDelta = new FakeDelta();
    return new OperatorTriggerLoop({
      delta: localDelta,
      memory: fakeMem(),
      registry: new TriggerRegistry(localDb),
      askAgent: async () => '[]',
      review: async () => ({ action: 'kept' as const }),
      pendingReportStore: {
        load: () => pendingRef.current,
        save: (state) => {
          pendingRef.current = structuredClone(state);
        },
      },
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
      ...over,
    });
  }

  it('retries the exact persisted report and delivery id after a pre-send restart', async () => {
    const pendingRef: { current: PendingReportState | null } = { current: null };
    const attempts: Array<{ text: string; deliveryId?: string }> = [];
    let fired = false;
    const scheduler = {
      shouldFire: () => ({ fire: !fired, hourKey: '2026-07-22:12' }),
      markFired: () => {
        fired = true;
      },
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const firstAsk = vi.fn(async () => 'stable report body');
    const first = durableLoop(pendingRef, {
      output: {
        send: async (text, deliveryId) => {
          attempts.push({ text, deliveryId });
          throw new Error('telegram unavailable');
        },
      },
      reportAsk: firstAsk,
      reportScheduler: scheduler,
    });

    await expect(first.tick()).rejects.toThrow('telegram unavailable');
    expect(pendingRef.current?.delivery?.text).toBe('stable report body');
    expect(pendingRef.current?.delivery?.deliveryId).toBeTruthy();

    const recoveryAsk = vi.fn(async () => 'must not regenerate');
    const recovered = durableLoop(pendingRef, {
      output: {
        send: async (text, deliveryId) => {
          attempts.push({ text, deliveryId });
        },
      },
      reportAsk: recoveryAsk,
      reportScheduler: scheduler,
    });
    await recovered.tick();

    expect(recoveryAsk).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(pendingRef.current?.delivery).toBeUndefined();
    expect(scheduler.markSuccess).toHaveBeenCalledOnce();
  });

  it('replays the same id after an accepted send whose completion state was not persisted', async () => {
    let durable: PendingReportState | null = null;
    let saveCount = 0;
    const visible = new Set<string>();
    const deliveries: string[] = [];
    let fired = false;
    const scheduler = {
      shouldFire: () => ({ fire: !fired, hourKey: '2026-07-22:13' }),
      markFired: () => {
        fired = true;
      },
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const first = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(new Database(':memory:')),
      askAgent: async () => '[]',
      reportAsk: async () => 'accepted report',
      review: async () => ({ action: 'kept' as const }),
      output: {
        send: async (_text, deliveryId) => {
          expect(deliveryId).toBeTruthy();
          deliveries.push(deliveryId!);
          visible.add(deliveryId!);
        },
      },
      reportScheduler: scheduler,
      pendingReportStore: {
        load: () => durable,
        save: (state) => {
          saveCount += 1;
          if (saveCount === 1) {
            durable = structuredClone(state);
            return;
          }
          throw new Error('simulated crash before completion persistence');
        },
      },
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    await expect(first.tick()).rejects.toThrow('completion persistence');
    expect(durable?.delivery).toBeDefined();
    expect(visible.size).toBe(1);

    const recovered = durableLoop(
      {
        get current() {
          return durable;
        },
        set current(value) {
          durable = value;
        },
      },
      {
        output: {
          send: async (_text, deliveryId) => {
            deliveries.push(deliveryId!);
            visible.add(deliveryId!);
          },
        },
        reportAsk: vi.fn(async () => 'must not regenerate'),
        reportScheduler: scheduler,
      }
    );
    await recovered.tick();

    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toBe(deliveries[0]);
    expect(visible.size).toBe(1);
  });

  it('uses independent delivery ids for identical on-demand and scheduled reports in one hour', async () => {
    const ids: string[] = [];
    const onDemand = durableLoop(
      { current: null },
      {
        output: { send: async (_text, deliveryId) => ids.push(deliveryId!) },
        reportAsk: async () => 'same body',
      }
    );
    expect(onDemand.startFullReport().accepted).toBe(true);
    await vi.waitFor(() => expect(ids).toHaveLength(1));

    const scheduled = durableLoop(
      { current: null },
      {
        output: { send: async (_text, deliveryId) => ids.push(deliveryId!) },
        reportAsk: async () => 'same body',
        reportScheduler: {
          shouldFire: () => ({ fire: true, hourKey: '2026-07-22:14' }),
          markFired: vi.fn(),
          loadLastSuccess: () => null,
          markSuccess: vi.fn(),
        },
      }
    );
    await scheduled.tick();

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('persists an accepted on-demand occurrence before report composition completes', async () => {
    const pendingRef: { current: PendingReportState | null } = { current: null };
    let releaseAsk!: (value: string) => void;
    const askBlocked = new Promise<string>((resolve) => {
      releaseAsk = resolve;
    });
    const send = vi.fn(async () => {});
    const loop = durableLoop(pendingRef, {
      output: { send },
      reportAsk: async () => askBlocked,
    });

    expect(loop.startFullReport()).toEqual({ accepted: true });
    expect(pendingRef.current?.request).toMatchObject({
      mode: 'full',
      occurrence: { kind: 'on_demand_full' },
    });
    expect(pendingRef.current?.request?.deliveryId).toBeTruthy();
    expect(send).not.toHaveBeenCalled();

    releaseAsk('durably accepted report');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(pendingRef.current?.request).toBeUndefined();
    expect(pendingRef.current?.delivery).toBeUndefined();
  });

  it('recovers an accepted on-demand request on startup with the same delivery id', async () => {
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    const deliveryId = 'operator-report:on_demand_full:accepted-before-crash';
    const pendingRef: { current: PendingReportState | null } = {
      current: {
        version: 1,
        digest: snapshot,
        full: snapshot,
        request: {
          mode: 'full',
          deliveryId,
          occurrence: {
            kind: 'on_demand_full',
            firedAtIso: '2026-07-22T04:30:00.000Z',
          },
          acceptedAtIso: '2026-07-22T04:30:00.000Z',
        },
      },
    };
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'recovered request report');
    const loop = durableLoop(pendingRef, { output: { send }, reportAsk });

    const stop = loop.start();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('recovered request report', deliveryId);
    });
    stop();

    expect(reportAsk).toHaveBeenCalledOnce();
    expect(pendingRef.current?.request).toBeUndefined();
  });

  it('returns busy instead of substituting an older pending delivery for a new request', async () => {
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    const pendingRef: { current: PendingReportState | null } = {
      current: {
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'full',
          text: 'older scheduled report',
          citedTriggerIds: [],
          createdAtIso: '2026-07-22T04:00:00.000Z',
          deliveryId: 'operator-report:scheduled:2026-07-22:13',
          occurrence: { kind: 'scheduled_full', hourKey: '2026-07-22:13' },
        },
      },
    };
    const reportAsk = vi.fn(async () => 'must not create a new report');
    const loop = durableLoop(pendingRef, {
      output: { send: async () => {} },
      reportAsk,
    });

    expect(loop.startFullReport()).toEqual({ accepted: false, reason: 'busy' });
    expect(reportAsk).not.toHaveBeenCalled();
    expect(pendingRef.current?.delivery?.text).toBe('older scheduled report');
  });

  it('replays a persisted delivery immediately on loop start without waiting for the first tick', async () => {
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    const pendingRef: { current: PendingReportState | null } = {
      current: {
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'digest',
          text: 'startup recovery report',
          citedTriggerIds: [],
          createdAtIso: '2026-07-22T03:30:00.000Z',
          deliveryId: 'operator-report:digest:startup-recovery',
          occurrence: { kind: 'digest' },
        },
      },
    };
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'must not regenerate');
    const loop = durableLoop(pendingRef, { output: { send }, reportAsk });

    const stop = loop.start();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'startup recovery report',
        'operator-report:digest:startup-recovery'
      );
      expect(pendingRef.current?.delivery).toBeUndefined();
    });
    stop();

    expect(reportAsk).not.toHaveBeenCalled();
  });
});
