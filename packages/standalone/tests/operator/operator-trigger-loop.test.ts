/**
 * Unit tests for OperatorTriggerLoop (M1-T3 - the setInterval-ticked runtime).
 * All deps injected (fake delta repo, fake memory, in-memory registry, stub agent/review)
 * so the tick pipeline is deterministic: drain -> match/fire + recordFire -> commit,
 * author on its cadence, review on its cadence. Real bindings are wired in M1-T4.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { OperatorTriggerLoop, type TickResult } from '../../src/operator/operator-trigger-loop.js';
import type {
  OperatorChannelEvent,
  OperatorMemoryPort,
} from '../../src/operator/operator-interfaces.js';
import type { CreateTriggerInput } from '../../src/operator/trigger-types.js';
import type { PendingReportState } from '../../src/operator/pending-report-store.js';
import {
  FilePendingReportStore,
  pendingReportDeliveryPayloadIdentity,
  pendingReportRequestPayloadIdentity,
} from '../../src/operator/pending-report-store.js';
import {
  createTelegramReportCarryDelivery,
  createTelegramReportOutput,
  type ReportCarryDeliveryStore,
} from '../../src/operator/report-carry-delivery.js';
import {
  FileReportCarryStore,
  type PersistDeliveredInput,
} from '../../src/operator/report-carry.js';
import type { SituationReporterSnapshot } from '../../src/operator/situation-report.js';

const TEST_REPORT_TARGET = { source: 'telegram', channelId: 'test-owner-chat' } as const;

function testReportOutput(
  send: (text: string, deliveryId?: string) => Promise<void>,
  channelId = TEST_REPORT_TARGET.channelId
) {
  return {
    target: { source: 'telegram' as const, channelId },
    send,
  };
}

function bindTestOutput<T extends Partial<ConstructorParameters<typeof OperatorTriggerLoop>[0]>>(
  over: T
): T {
  if (!over.output) return over;
  return {
    ...over,
    output: {
      target: TEST_REPORT_TARGET,
      ...over.output,
    },
  };
}

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
      ...bindTestOutput(over),
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
    // The batch rides alongside the prompt lines now: the ids were always inside the
    // lines as `[id:evt_...]` text, and carrying them structurally is what lets a bounded
    // run attribute what it changes without asking the agent to restate anything.
    expect(onChannelDelta).toHaveBeenCalledWith(
      'slack:owner',
      expect.arrayContaining([expect.stringContaining('board delta that must survive restart')]),
      expect.any(Array)
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
      ...(over.output && typeof over.output === 'object'
        ? {
            ...over,
            output: { target: TEST_REPORT_TARGET, ...(over.output as Record<string, unknown>) },
          }
        : over),
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
      ...bindTestOutput(over),
    });
  }

  it('TG-01/TG-06 drives scheduled and on-demand successful sends through one target-scoped production carry assembly', async () => {
    class CapturingCarryStore extends FileReportCarryStore {
      readonly persisted: PersistDeliveredInput[] = [];

      override persistDelivered(input: PersistDeliveredInput): void {
        this.persisted.push(structuredClone(input));
        super.persistDelivered(input);
      }
    }

    const root = await mkdtemp(join(tmpdir(), 'mama-report-carry-delivery-'));
    const path = join(root, 'carry.json');
    const carryStore: ReportCarryDeliveryStore & CapturingCarryStore = new CapturingCarryStore(
      path
    );
    const deliverToCarry = createTelegramReportCarryDelivery({
      reportChatId: 'trusted-owner-chat',
      carryStore,
    });
    const deliveredReports: Array<Parameters<typeof deliverToCarry>[0]> = [];
    const persistLastFullReport = (report: Parameters<typeof deliverToCarry>[0]): void => {
      deliveredReports.push(structuredClone(report));
      deliverToCarry(report);
    };
    const sent: Array<{ chatId: string; text: string; deliveryId?: string }> = [];
    const output = createTelegramReportOutput({
      reportChatId: 'trusted-owner-chat',
      telegramSender: {
        async sendSystemMessage(chatId, text, deliveryId) {
          sent.push({ chatId, text, deliveryId });
        },
      },
    });

    const onDemand = durableLoop(
      { current: null },
      {
        output,
        reportAsk: async () => 'on-demand owner report',
        fullReportProvenance: () => ({ status: 'available', modelRunId: 'mr_on_demand' }),
        persistLastFullReport,
      }
    );
    expect(onDemand.startFullReport()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const scheduled = durableLoop(
      { current: null },
      {
        output,
        reportAsk: async () => 'scheduled owner report',
        fullReportProvenance: () => ({ status: 'available', modelRunId: 'mr_scheduled' }),
        persistLastFullReport,
        reportScheduler: {
          shouldFire: () => ({ fire: true, hourKey: '2026-08-02:09' }),
          markFired: vi.fn(),
          loadLastSuccess: () => null,
          markSuccess: vi.fn(),
        },
      }
    );
    await scheduled.tick();

    expect(sent).toEqual([
      {
        chatId: 'trusted-owner-chat',
        text: 'on-demand owner report',
        deliveryId: expect.stringMatching(/^operator-report:on_demand_full:/),
      },
      {
        chatId: 'trusted-owner-chat',
        text: 'scheduled owner report',
        deliveryId: 'operator-report:scheduled:2026-08-02:09',
      },
    ]);
    expect(carryStore.persisted).toHaveLength(2);
    expect(carryStore.persisted[0]).toMatchObject({
      deliveryId: sent[0].deliveryId,
      target: { source: 'telegram', channelId: 'trusted-owner-chat' },
      text: sent[0].text,
      provenance: { status: 'available', modelRunId: 'mr_on_demand' },
    });
    expect(carryStore.persisted[1]).toMatchObject({
      deliveryId: sent[1].deliveryId,
      target: { source: 'telegram', channelId: 'trusted-owner-chat' },
      text: sent[1].text,
      provenance: { status: 'available', modelRunId: 'mr_scheduled' },
    });
    expect(carryStore.persisted[1].deliveredAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 2,
      ...carryStore.persisted[1],
    });

    expect(
      carryStore.acknowledge({
        deliveryId: carryStore.persisted[1].deliveryId,
        target: { source: 'telegram', channelId: 'trusted-owner-chat' },
        consumingChannelKey: 'telegram:trusted-owner-chat',
        consumedAtIso: '2026-08-02T00:01:00.000Z',
      })
    ).toBe(true);
    persistLastFullReport(deliveredReports[1]!);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      deliveryId: carryStore.persisted[1].deliveryId,
      consumedAt: '2026-08-02T00:01:00.000Z',
      consumingChannelKey: 'telegram:trusted-owner-chat',
    });
  });

  it('TG-06 leaves the production carry store untouched when a full-report send is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-carry-rejected-'));
    const path = join(root, 'carry.json');
    const carryStore = new FileReportCarryStore(path);
    const loop = durableLoop(
      { current: null },
      {
        output: {
          send: async () => {
            throw new Error('telegram rejected');
          },
        },
        reportAsk: async () => 'rejected owner report',
        fullReportProvenance: () => ({ status: 'available', modelRunId: 'mr_rejected' }),
        persistLastFullReport: createTelegramReportCarryDelivery({
          reportChatId: 'trusted-owner-chat',
          carryStore,
        }),
        reportScheduler: {
          shouldFire: () => ({ fire: true, hourKey: '2026-08-02:10' }),
          markFired: vi.fn(),
          loadLastSuccess: () => null,
          markSuccess: vi.fn(),
        },
      }
    );

    await expect(loop.tick()).rejects.toThrow('telegram rejected');
    expect(existsSync(path)).toBe(false);
  });

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

  it('TG-06 refuses a pending delivery when restart configuration changes from Telegram A to B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-target-drift-'));
    const path = join(root, 'pending.json');
    const firstSend = vi.fn(async () => {
      throw new Error('telegram unavailable');
    });
    const first = durableLoop(
      { current: null },
      {
        pendingReportStore: new FilePendingReportStore(path),
        output: createTelegramReportOutput({
          reportChatId: 'owner-chat-A',
          telegramSender: { sendSystemMessage: firstSend },
        }),
        reportAsk: async () => 'owner report for A',
        reportScheduler: {
          shouldFire: () => ({ fire: true, hourKey: '2026-08-02:09' }),
          markFired: vi.fn(),
          loadLastSuccess: () => null,
          markSuccess: vi.fn(),
        },
      }
    );

    await expect(first.tick()).rejects.toThrow('telegram unavailable');
    expect(new FilePendingReportStore(path).load()?.delivery?.target).toEqual({
      source: 'telegram',
      channelId: 'owner-chat-A',
    });

    const secondSend = vi.fn(async () => {});
    const carryPath = join(root, 'carry-B.json');
    const second = durableLoop(
      { current: null },
      {
        pendingReportStore: new FilePendingReportStore(path),
        output: createTelegramReportOutput({
          reportChatId: 'owner-chat-B',
          telegramSender: { sendSystemMessage: secondSend },
        }),
        reportAsk: async () => 'must not regenerate for B',
        persistLastFullReport: createTelegramReportCarryDelivery({
          reportChatId: 'owner-chat-B',
          carryStore: new FileReportCarryStore(carryPath),
        }),
      }
    );

    await expect(second.tick()).rejects.toThrow(/target.*owner-chat-A.*owner-chat-B/i);
    expect(secondSend).not.toHaveBeenCalled();
    expect(existsSync(carryPath)).toBe(false);
    expect(new FilePendingReportStore(path).load()?.delivery?.text).toBe('owner report for A');
  });

  it('TG-06 refuses a pending accepted request when restart configuration changes from Telegram A to B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-request-target-drift-'));
    const path = join(root, 'pending.json');
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    const target = { source: 'telegram', channelId: 'owner-chat-A' } as const;
    const request = {
      mode: 'full' as const,
      deliveryId: 'operator-report:on_demand_full:accepted-for-A',
      occurrence: {
        kind: 'on_demand_full' as const,
        firedAtIso: '2026-08-02T00:00:00.000Z',
      },
      acceptedAtIso: '2026-08-02T00:00:00.000Z',
      target,
    };
    new FilePendingReportStore(path).save({
      version: 1,
      digest: snapshot,
      full: snapshot,
      request: {
        ...request,
        payloadIdentity: pendingReportRequestPayloadIdentity(request),
      },
    });
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'must not compose for B');
    const restarted = durableLoop(
      { current: null },
      {
        pendingReportStore: new FilePendingReportStore(path),
        output: createTelegramReportOutput({
          reportChatId: 'owner-chat-B',
          telegramSender: { sendSystemMessage: send },
        }),
        reportAsk,
      }
    );

    await expect(restarted.tick()).rejects.toThrow(/target.*owner-chat-A.*owner-chat-B/i);
    expect(reportAsk).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(new FilePendingReportStore(path).load()?.request?.deliveryId).toBe(request.deliveryId);
  });

  it('TG-06 quarantines an invalid pending full delivery before restart recovery can send or advance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'full',
          text: 'invalid old report',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: '   ',
          provenance: { status: 'available', modelRunId: 'mr_current_1' },
          occurrence: { kind: 'scheduled_full', hourKey: '2026-08-02:09' },
        },
      })
    );
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'must not compose a replacement');
    const markFired = vi.fn();
    const markSuccess = vi.fn();
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(new Database(':memory:')),
      askAgent: async () => '[]',
      reportAsk,
      review: async () => ({ action: 'kept' as const }),
      output: { send },
      reportScheduler: {
        shouldFire: () => ({ fire: false, hourKey: '2026-08-02:09' }),
        markFired,
        loadLastSuccess: () => null,
        markSuccess,
      },
      pendingReportStore: new FilePendingReportStore(path),
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    await loop.tick();

    expect(send).not.toHaveBeenCalled();
    expect(reportAsk).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
    expect(markSuccess).not.toHaveBeenCalled();
  });

  it.each([
    [
      'provenance',
      (delivery: Record<string, unknown>) => {
        delivery.provenance = { status: 'available', modelRunId: 'mr_mutated' };
      },
    ],
    [
      'scheduled occurrence',
      (delivery: Record<string, unknown>) => {
        delivery.occurrence = {
          kind: 'scheduled_full',
          hourKey: '2026-08-02:10',
          firedAtIso: '2026-08-02T01:00:00.000Z',
        };
      },
    ],
  ] as const)(
    'TG-06 quarantines a pending delivery with mutated %s before send, carry, or scheduler mutation',
    async (_field, mutate) => {
      const root = await mkdtemp(join(tmpdir(), 'mama-report-identity-mutation-'));
      const path = join(root, 'pending.json');
      const snapshot = new (
        await import('../../src/operator/situation-report.js')
      ).SituationReporter().snapshot();
      const delivery = {
        mode: 'full' as const,
        text: 'authorized owner report',
        citedTriggerIds: ['trigger-1'],
        createdAtIso: '2026-08-02T00:00:00.000Z',
        deliveryId: 'fully-bound-d1',
        provenance: { status: 'available' as const, modelRunId: 'mr_original' },
        occurrence: {
          kind: 'scheduled_full' as const,
          hourKey: '2026-08-02:09',
          firedAtIso: '2026-08-02T00:00:00.000Z',
        },
        target: TEST_REPORT_TARGET,
      };
      const state = {
        version: 1 as const,
        digest: snapshot,
        full: snapshot,
        delivery: {
          ...delivery,
          payloadIdentity: pendingReportDeliveryPayloadIdentity(delivery),
        },
      };
      const tampered = structuredClone(state);
      mutate(tampered.delivery as unknown as Record<string, unknown>);
      await writeFile(path, JSON.stringify(tampered));

      const send = vi.fn(async () => {});
      const persistLastFullReport = vi.fn();
      const reportAsk = vi.fn(async () => 'must not compose replacement');
      const scheduler = {
        shouldFire: vi.fn(() => ({ fire: true, hourKey: '2026-08-02:11' })),
        markFired: vi.fn(),
        loadLastSuccess: () => null,
        markSuccess: vi.fn(),
      };
      const loop = durableLoop(
        { current: null },
        {
          pendingReportStore: new FilePendingReportStore(path),
          output: testReportOutput(send),
          persistLastFullReport,
          reportAsk,
          reportScheduler: scheduler,
        }
      );

      await loop.tick();

      expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
      expect(send).not.toHaveBeenCalled();
      expect(persistLastFullReport).not.toHaveBeenCalled();
      expect(reportAsk).not.toHaveBeenCalled();
      expect(scheduler.shouldFire).not.toHaveBeenCalled();
      expect(scheduler.markFired).not.toHaveBeenCalled();
      expect(scheduler.markSuccess).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'scheduled delivery',
      (snapshot: SituationReporterSnapshot) => {
        const delivery = {
          mode: 'full' as const,
          text: 'owner report',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'unknown-scheduled-key-d1',
          provenance: { status: 'available' as const, modelRunId: 'mr_original' },
          occurrence: {
            kind: 'scheduled_full' as const,
            hourKey: '2026-08-02:09',
            unknown: 'substitutes-for-firedAtIso',
          },
          target: TEST_REPORT_TARGET,
        };
        return {
          version: 1 as const,
          digest: snapshot,
          full: snapshot,
          delivery: {
            ...delivery,
            payloadIdentity: pendingReportDeliveryPayloadIdentity(delivery),
          },
        };
      },
    ],
    [
      'on-demand request',
      (snapshot: SituationReporterSnapshot) => {
        const request = {
          mode: 'full' as const,
          deliveryId: 'unknown-on-demand-key-d1',
          occurrence: {
            kind: 'on_demand_full' as const,
            firedAtIso: '2026-08-02T00:00:00.000Z',
            unknown: 'substitutes-for-hourKey',
          },
          acceptedAtIso: '2026-08-02T00:00:00.000Z',
          target: TEST_REPORT_TARGET,
        };
        return {
          version: 1 as const,
          digest: snapshot,
          full: snapshot,
          request: {
            ...request,
            payloadIdentity: pendingReportRequestPayloadIdentity(request),
          },
        };
      },
    ],
  ] as const)(
    'TG-06 quarantines a persisted %s with an unknown occurrence key before report side effects',
    async (_phase, buildState) => {
      const root = await mkdtemp(join(tmpdir(), 'mama-report-occurrence-schema-'));
      const path = join(root, 'pending.json');
      const snapshot = new (
        await import('../../src/operator/situation-report.js')
      ).SituationReporter().snapshot();
      await writeFile(path, JSON.stringify(buildState(snapshot)));

      const send = vi.fn(async () => {});
      const persistLastFullReport = vi.fn();
      const reportAsk = vi.fn(async () => 'must not compose replacement');
      const scheduler = {
        shouldFire: vi.fn(() => ({ fire: true, hourKey: '2026-08-02:11' })),
        markFired: vi.fn(),
        loadLastSuccess: () => null,
        markSuccess: vi.fn(),
      };
      const loop = durableLoop(
        { current: null },
        {
          pendingReportStore: new FilePendingReportStore(path),
          output: testReportOutput(send),
          persistLastFullReport,
          reportAsk,
          reportScheduler: scheduler,
        }
      );

      await loop.tick();

      expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
      expect(send).not.toHaveBeenCalled();
      expect(persistLastFullReport).not.toHaveBeenCalled();
      expect(reportAsk).not.toHaveBeenCalled();
      expect(scheduler.shouldFire).not.toHaveBeenCalled();
      expect(scheduler.markFired).not.toHaveBeenCalled();
      expect(scheduler.markSuccess).not.toHaveBeenCalled();
    }
  );

  it('TG-06 quarantines a state with both pending phases before restart recovery can send or advance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'digest',
          text: 'old digest',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'digest-1',
          occurrence: { kind: 'digest' },
        },
        request: {
          mode: 'full',
          deliveryId: 'request-1',
          acceptedAtIso: '2026-08-02T00:00:00.000Z',
          occurrence: {
            kind: 'on_demand_full',
            firedAtIso: '2026-08-02T00:00:00.000Z',
          },
        },
      })
    );
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'must not compose a replacement');
    const markFired = vi.fn();
    const markSuccess = vi.fn();
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(new Database(':memory:')),
      askAgent: async () => '[]',
      reportAsk,
      review: async () => ({ action: 'kept' as const }),
      output: { send },
      reportScheduler: {
        shouldFire: () => ({ fire: false, hourKey: '2026-08-02:09' }),
        markFired,
        loadLastSuccess: () => null,
        markSuccess,
      },
      pendingReportStore: new FilePendingReportStore(path),
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    await loop.tick();

    expect(send).not.toHaveBeenCalled();
    expect(reportAsk).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
    expect(markSuccess).not.toHaveBeenCalled();
  });

  it('TG-06 blocks replacement reports until the same live loop observes explicit recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'digest',
          text: 'valid but mutually exclusive digest',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'digest-1',
          occurrence: { kind: 'digest' },
        },
        request: {
          mode: 'full',
          deliveryId: 'request-1',
          acceptedAtIso: '2026-08-02T00:00:00.000Z',
          occurrence: {
            kind: 'on_demand_full',
            firedAtIso: '2026-08-02T00:00:00.000Z',
          },
        },
      })
    );
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'must not compose a replacement');
    const markFired = vi.fn();
    const markSuccess = vi.fn();
    const scheduler = {
      shouldFire: vi.fn(() => ({ fire: true, hourKey: '2026-08-02:09' })),
      markFired,
      loadLastSuccess: () => null,
      markSuccess,
    };
    const makeBlockedLoop = () =>
      new OperatorTriggerLoop({
        delta: new FakeDelta(),
        memory: fakeMem(),
        registry: new TriggerRegistry(new Database(':memory:')),
        askAgent: async () => '[]',
        reportAsk,
        review: async () => ({ action: 'kept' as const }),
        output: testReportOutput(send),
        reportScheduler: scheduler,
        pendingReportStore: new FilePendingReportStore(path),
        config: {
          tickMs: 60_000,
          drainLimit: 50,
          authorEveryNTicks: 99,
          reviewEveryNTicks: 99,
          authorWindowSize: 10,
        },
        log: () => {},
      });

    const first = makeBlockedLoop();
    await first.tick();
    expect(first.startFullReport()).toEqual({ accepted: false, reason: 'unavailable' });

    const restarted = makeBlockedLoop();
    await restarted.tick();
    expect(restarted.startFullReport()).toEqual({ accepted: false, reason: 'unavailable' });

    expect(reportAsk).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
    expect(markSuccess).not.toHaveBeenCalled();
    expect(scheduler.shouldFire).not.toHaveBeenCalled();

    new FilePendingReportStore(path).recoverWithValidState({
      version: 1,
      digest: snapshot,
      full: snapshot,
    });
    await first.tick();

    expect(scheduler.shouldFire).toHaveBeenCalledOnce();
    expect(reportAsk).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(markFired).toHaveBeenCalledWith('2026-08-02:09');
    expect(markSuccess).toHaveBeenCalledOnce();
  });

  it('TG-06 treats an absent pending outbox as eligible for the scheduled full report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'normal scheduled full report');
    const markFired = vi.fn();
    const markSuccess = vi.fn();
    const scheduler = {
      shouldFire: vi.fn(() => ({ fire: true, hourKey: '2026-08-02:09' })),
      markFired,
      loadLastSuccess: () => null,
      markSuccess,
    };
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(new Database(':memory:')),
      askAgent: async () => '[]',
      reportAsk,
      review: async () => ({ action: 'kept' as const }),
      output: testReportOutput(send),
      reportScheduler: scheduler,
      pendingReportStore: new FilePendingReportStore(path),
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    await loop.tick();

    expect(scheduler.shouldFire).toHaveBeenCalledOnce();
    expect(reportAsk).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      'normal scheduled full report',
      'operator-report:scheduled:2026-08-02:09'
    );
    expect(markFired).toHaveBeenCalledWith('2026-08-02:09');
    expect(markSuccess).toHaveBeenCalledOnce();
  });

  it('TG-06 rehydrates and replays an explicitly recovered d1 in the same live loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({ version: 1, digest: snapshot, full: { invalid: true } })
    );
    const store = new FilePendingReportStore(path);
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'must not compose d2');
    const scheduler = {
      shouldFire: vi.fn(() => ({ fire: true, hourKey: '2026-08-02:09' })),
      markFired: vi.fn(),
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(new Database(':memory:')),
      askAgent: async () => '[]',
      reportAsk,
      review: async () => ({ action: 'kept' as const }),
      output: testReportOutput(send),
      reportScheduler: scheduler,
      pendingReportStore: store,
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    const recoveredDelivery = {
      mode: 'full' as const,
      deliveryId: 'd1',
      target: TEST_REPORT_TARGET,
      text: 'recovered d1',
      citedTriggerIds: [],
      createdAtIso: '2026-08-02T00:00:00.000Z',
      provenance: { status: 'available' as const, modelRunId: 'mr_d1' },
      occurrence: { kind: 'scheduled_full' as const, hourKey: '2026-08-02:09' },
    };
    store.recoverWithValidState({
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: {
        ...recoveredDelivery,
        payloadIdentity: pendingReportDeliveryPayloadIdentity(recoveredDelivery),
      },
    });

    await loop.tick();

    expect(send).toHaveBeenCalledWith('recovered d1', 'd1');
    expect(reportAsk).not.toHaveBeenCalled();
    expect(scheduler.shouldFire).not.toHaveBeenCalled();
    expect(store.loadOutcome().status).toBe('ready');
  });

  it('TG-06 composes an explicitly recovered accepted request once before scheduled work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({ version: 1, digest: snapshot, full: { invalid: true } })
    );
    const store = new FilePendingReportStore(path);
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'recovered request d1');
    const scheduler = {
      shouldFire: vi.fn(() => ({ fire: true, hourKey: '2026-08-02:09' })),
      markFired: vi.fn(),
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(new Database(':memory:')),
      askAgent: async () => '[]',
      reportAsk,
      review: async () => ({ action: 'kept' as const }),
      output: testReportOutput(send),
      reportScheduler: scheduler,
      pendingReportStore: store,
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    const recoveredRequest = {
      mode: 'full' as const,
      deliveryId: 'd1-request',
      acceptedAtIso: '2026-08-02T00:00:00.000Z',
      occurrence: {
        kind: 'on_demand_full' as const,
        firedAtIso: '2026-08-02T00:00:00.000Z',
      },
      target: TEST_REPORT_TARGET,
    };
    store.recoverWithValidState({
      version: 1,
      digest: snapshot,
      full: snapshot,
      request: {
        ...recoveredRequest,
        payloadIdentity: pendingReportRequestPayloadIdentity(recoveredRequest),
      },
    });

    await loop.tick();

    expect(reportAsk).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('recovered request d1', 'd1-request');
    expect(scheduler.shouldFire).not.toHaveBeenCalled();
  });

  it('TG-06 fails closed then replays external recovery when a fresh save loses its CAS race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new (
      await import('../../src/operator/situation-report.js')
    ).SituationReporter().snapshot();
    const fileStore = new FilePendingReportStore(path);
    const recovered = {
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: (() => {
        const delivery = {
          mode: 'digest' as const,
          text: 'external d1 wins',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'd1',
          occurrence: { kind: 'digest' as const },
          target: TEST_REPORT_TARGET,
        };
        return {
          ...delivery,
          payloadIdentity: pendingReportDeliveryPayloadIdentity(delivery),
        };
      })(),
    };
    let injectRecovery = true;
    const raceStore = {
      loadOutcome: () => fileStore.loadOutcome(),
      load: () => fileStore.load(),
      loadStatus: () => fileStore.loadStatus(),
      save: (
        state: PendingReportState,
        expected?: Parameters<FilePendingReportStore['save']>[1]
      ) => {
        if (injectRecovery) {
          injectRecovery = false;
          fileStore.recoverWithValidState(recovered);
        }
        fileStore.save(state, expected);
      },
    };
    const send = vi.fn(async () => {});
    const reportAsk = vi.fn(async () => 'fresh d2 must not send');
    const scheduler = {
      shouldFire: vi.fn(() => ({ fire: true, hourKey: '2026-08-02:09' })),
      markFired: vi.fn(),
      loadLastSuccess: () => null,
      markSuccess: vi.fn(),
    };
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(new Database(':memory:')),
      askAgent: async () => '[]',
      reportAsk,
      review: async () => ({ action: 'kept' as const }),
      output: testReportOutput(send),
      reportScheduler: scheduler,
      pendingReportStore: raceStore,
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    await expect(loop.tick()).rejects.toThrow(
      'Pending owner-report state changed before normal save'
    );
    expect(send).not.toHaveBeenCalled();
    expect(fileStore.loadOutcome()).toMatchObject({
      status: 'ready',
      state: { delivery: { deliveryId: 'd1', text: 'external d1 wins' } },
    });

    await loop.tick();

    expect(send).toHaveBeenCalledWith('external d1 wins', 'd1');
    expect(scheduler.shouldFire).toHaveBeenCalledOnce();
  });

  it('TG-06 replays the prepared full-report provenance instead of a new process provider', async () => {
    const pendingRef: { current: PendingReportState | null } = { current: null };
    const first = durableLoop(pendingRef, {
      output: {
        send: async () => {
          throw new Error('telegram unavailable');
        },
      },
      reportAsk: async () => 'stable report body',
      fullReportProvenance: () => ({ status: 'available', modelRunId: 'mr_original' }),
      reportScheduler: {
        shouldFire: () => ({ fire: true, hourKey: '2026-08-02:09' }),
        markFired: vi.fn(),
        loadLastSuccess: () => null,
        markSuccess: vi.fn(),
      },
    });

    await expect(first.tick()).rejects.toThrow('telegram unavailable');
    expect(pendingRef.current?.delivery?.provenance).toEqual({
      status: 'available',
      modelRunId: 'mr_original',
    });

    const persisted: unknown[] = [];
    const recovered = durableLoop(pendingRef, {
      output: { send: async () => {} },
      fullReportProvenance: () => ({ status: 'available', modelRunId: 'mr_wrong_process' }),
      persistLastFullReport: (report) => persisted.push(report),
      reportScheduler: {
        shouldFire: () => ({ fire: false, hourKey: '2026-08-02:09' }),
        markFired: vi.fn(),
        loadLastSuccess: () => null,
        markSuccess: vi.fn(),
      },
    });

    await recovered.tick();

    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { provenance: unknown }).provenance).toEqual({
      status: 'available',
      modelRunId: 'mr_original',
    });
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
        target: TEST_REPORT_TARGET,
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

  it('TG-06 passes exact prepared scheduled and on-demand deliveries to the same carry boundary', async () => {
    const carried: Array<{
      deliveryId: string;
      text: string;
      provenance: unknown;
    }> = [];
    const onDemand = durableLoop(
      { current: null },
      {
        output: { send: async () => {} },
        reportAsk: async () => 'on-demand owner report',
        fullReportProvenance: () => ({ status: 'available', modelRunId: 'mr_on_demand' }),
        persistLastFullReport: (report) => carried.push(report),
      }
    );
    expect(onDemand.startFullReport()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(carried).toHaveLength(1));

    const scheduled = durableLoop(
      { current: null },
      {
        output: { send: async () => {} },
        reportAsk: async () => 'scheduled owner report',
        fullReportProvenance: () => ({ status: 'available', modelRunId: 'mr_scheduled' }),
        persistLastFullReport: (report) => carried.push(report),
        reportScheduler: {
          shouldFire: () => ({ fire: true, hourKey: '2026-08-02:09' }),
          markFired: vi.fn(),
          loadLastSuccess: () => null,
          markSuccess: vi.fn(),
        },
      }
    );
    await scheduled.tick();

    expect(carried).toHaveLength(2);
    expect(carried[0]).toMatchObject({
      deliveryId: expect.stringMatching(/^operator-report:on_demand_full:/),
      text: 'on-demand owner report',
      provenance: { status: 'available', modelRunId: 'mr_on_demand' },
    });
    expect(carried[1]).toMatchObject({
      deliveryId: 'operator-report:scheduled:2026-08-02:09',
      text: 'scheduled owner report',
      provenance: { status: 'available', modelRunId: 'mr_scheduled' },
    });
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
    const acceptedRequest = {
      mode: 'full' as const,
      deliveryId,
      occurrence: {
        kind: 'on_demand_full' as const,
        firedAtIso: '2026-07-22T04:30:00.000Z',
      },
      acceptedAtIso: '2026-07-22T04:30:00.000Z',
      target: TEST_REPORT_TARGET,
    };
    const pendingRef: { current: PendingReportState | null } = {
      current: {
        version: 1,
        digest: snapshot,
        full: snapshot,
        request: {
          ...acceptedRequest,
          payloadIdentity: pendingReportRequestPayloadIdentity(acceptedRequest),
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
    const startupDelivery = {
      mode: 'digest' as const,
      deliveryId: 'operator-report:digest:startup-recovery',
      text: 'startup recovery report',
      citedTriggerIds: [],
      createdAtIso: '2026-07-22T03:30:00.000Z',
      occurrence: { kind: 'digest' as const },
      target: TEST_REPORT_TARGET,
    };
    const pendingRef: { current: PendingReportState | null } = {
      current: {
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          ...startupDelivery,
          payloadIdentity: pendingReportDeliveryPayloadIdentity(startupDelivery),
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
