/**
 * TG-05/TG-06 Slice I: the trigger loop submits owner reports through ONE
 * ReportDeliveryPort and advances scheduler success, trigger credit, and
 * pending-file cleanup ONLY on `delivered` (design Decisions 1-2).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import Database from '../../src/sqlite.js';
import { OperatorTriggerLoop } from '../../src/operator/operator-trigger-loop.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';
import type {
  OperatorChannelEvent,
  OperatorMemoryPort,
} from '../../src/operator/operator-interfaces.js';
import type {
  ReportDeliveryOutcome,
  ReportDeliveryPort,
} from '../../src/operator/report-delivery-coordinator.js';
import {
  ReportDeliveryCoordinator,
  type ReportDeliveryBinding,
  type ReportDeliveryLease,
  type TelegramReportDeliveryControl,
} from '../../src/operator/report-delivery-coordinator.js';
import type { PendingReportDelivery } from '../../src/operator/pending-report-store.js';
import type { PendingReportState } from '../../src/operator/pending-report-store.js';
import { compileOwnerReportContext } from '../../src/operator/report-context.js';
import { createPersonaReportAsk } from '../../src/operator/report-run.js';

const TARGET = { source: 'telegram', channelId: 'test-owner-chat' } as const;

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

function fakeMem(): OperatorMemoryPort {
  return {
    async save() {},
    async recall() {
      return [];
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

class FakePort implements ReportDeliveryPort {
  outcome: ReportDeliveryOutcome = { status: 'delivered' };
  calls: PendingReportDelivery[] = [];
  async deliverPrepared(report: PendingReportDelivery): Promise<ReportDeliveryOutcome> {
    this.calls.push(report);
    return this.outcome;
  }
}

function makeScheduler(fire = false) {
  const state = { fired: [] as string[], success: [] as string[] };
  return {
    state,
    shouldFire: () => ({ fire, hourKey: '2026-08-06:13' }),
    markFired: (hourKey: string) => state.fired.push(hourKey),
    loadLastSuccess: () => null,
    markSuccess: (iso: string) => state.success.push(iso),
  };
}

function harness(port: FakePort, options: { scheduledFire?: boolean } = {}) {
  const delta = new FakeDelta();
  const registry = new TriggerRegistry(new Database(':memory:'));
  const logs: string[] = [];
  let pending: PendingReportState | null = null;
  const pendingReportStore = {
    load: () => pending,
    save: (state: PendingReportState) => {
      pending = structuredClone(state);
    },
  };
  const scheduler = makeScheduler(options.scheduledFire ?? false);
  const loop = new OperatorTriggerLoop({
    delta,
    memory: fakeMem(),
    registry,
    askAgent: async () => '[]',
    reportAsk: async () => 'owner digest body\nUSED_TRIGGERS: none',
    review: async () => ({ action: 'kept' as const }),
    reportDelivery: port,
    reportTarget: TARGET,
    reportScheduler: scheduler,
    pendingReportStore,
    config: {
      tickMs: 60_000,
      drainLimit: 50,
      authorEveryNTicks: 99,
      reviewEveryNTicks: 99,
      authorWindowSize: 10,
      reportEveryNTicks: 1,
    },
    log: (line) => logs.push(line),
  });
  return { loop, delta, registry, logs, scheduler, pendingState: () => pending };
}

describe('OperatorTriggerLoop + ReportDeliveryPort', () => {
  it('TG-01/TG-03/TG-04/TG-05/TG-06 carries one scoped full-report turn through a durable delivered receipt', async () => {
    const db = new Database(':memory:');
    const reportStore = new TelegramReportContextStore(db);
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-full-report-e2e-'));
    const deliveryCalls: string[] = [];
    const deliveryControl: TelegramReportDeliveryControl = {
      async claimAndPin(binding: ReportDeliveryBinding): Promise<ReportDeliveryLease> {
        deliveryCalls.push(`claim:${binding.deliveryId}`);
        return { deliveryId: binding.deliveryId };
      },
      async sendPinned(lease: ReportDeliveryLease) {
        deliveryCalls.push(`send:${lease.deliveryId}`);
        return { kind: 'confirmed' as const };
      },
      async releasePin(deliveryId: string): Promise<void> {
        deliveryCalls.push(`release:${deliveryId}`);
      },
      async reconcilePins(): Promise<void> {},
    };
    const delivery = new ReportDeliveryCoordinator({
      store: reportStore,
      control: deliveryControl,
      ownerTarget: TARGET,
      executorId: 'offline-e2e',
      nowIso: () => '2026-09-02T00:00:00.000Z',
      mamaHome,
    });
    const modelRun = vi.fn(async (_prompt: string, sourceMessageRef?: string) => ({
      response: 'Grounded owner report',
      history: [],
      turns: 1,
      modelRunId: 'offline-model-run',
      sourceMessageRef,
    }));
    let composedProvenance:
      | { status: 'available'; modelRunId: string }
      | { status: 'unavailable'; reason: string }
      | undefined;
    const reportAsk = createPersonaReportAsk({
      run: modelRun,
      log: () => {},
      onRunProvenance: (provenance) => {
        composedProvenance = provenance;
      },
    });
    const compile = vi.fn(
      async ({
        readScope,
        windowEvidence,
        since,
      }: Parameters<
        NonNullable<
          ConstructorParameters<typeof OperatorTriggerLoop>[0]['compileFullReportContext']
        >
      >[0]) =>
        compileOwnerReportContext(
          { readScope, windowEvidence, since },
          {
            listTaskPage: () => ({ tasks: [], total: 0, returned: 0, nextCursor: null }),
            readClaims: async () => [],
            readTrello: async () => ({
              observedAt: '2026-09-02T00:00:00.000Z',
              cacheAgeMs: 0,
              complete: true,
              truncated: false,
              boards: [
                { boardId: 'board-safe', board: 'Board', status: 'ok', rosterDegraded: false },
              ],
              columns: [],
            }),
            buildProvenanceLookup: async () => () => null,
            correlate: () => ({
              correlations: [],
              coverage: {
                total: 0,
                matched: 0,
                unmatched: 0,
                ambiguous: 0,
                historical_only: 0,
                not_applicable: 0,
              },
            }),
            readChanges: (_scope, input) => ({
              success: true,
              since: String(input.since),
              total: 0,
              returned: 0,
              coverage: { attributed: 0, unattributed: 0 },
              changes: [],
            }),
            now: () => Date.parse('2026-09-02T00:00:00.000Z'),
          }
        )
    );
    const pendingSnapshots: PendingReportState[] = [];
    let pending: PendingReportState | null = null;
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(db),
      askAgent: async () => '[]',
      reportAsk,
      fullReportProvenance: () => composedProvenance,
      compileFullReportContext: compile,
      fullReportReadScope: {
        projectRefs: [{ kind: 'project', id: 'offline-project' }],
        memoryScopes: [{ kind: 'project', id: 'offline-project' }],
        rawConnectors: ['trello'],
      },
      review: async () => ({ action: 'kept' as const }),
      reportDelivery: delivery,
      reportTarget: TARGET,
      reportScheduler: {
        shouldFire: () => ({ fire: true, hourKey: '2026-09-02:00' }),
        markFired: vi.fn(),
        loadLastSuccess: () => null,
        markSuccess: vi.fn(),
      },
      pendingReportStore: {
        load: () => pending,
        save: (state) => {
          pending = structuredClone(state);
          pendingSnapshots.push(structuredClone(state));
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

    try {
      await loop.tick();

      expect(compile).toHaveBeenCalledOnce();
      expect(modelRun).toHaveBeenCalledOnce();
      const sourceMessageRef = modelRun.mock.calls[0]?.[1];
      expect(sourceMessageRef).toMatch(/^owner-report-context:[a-f0-9]{64}$/);
      expect(
        pendingSnapshots.some(
          (state) =>
            state.request?.contextJson?.includes('mama.owner-report-context/v1') &&
            state.request.contextSha256 &&
            sourceMessageRef === `owner-report-context:${state.request.contextSha256}`
        )
      ).toBe(true);
      const prepared = pendingSnapshots.find((state) => state.delivery)?.delivery;
      expect(prepared).toMatchObject({
        mode: 'full',
        text: 'Grounded owner report',
        provenance: { status: 'available', modelRunId: 'offline-model-run' },
      });
      expect(deliveryCalls.map((call) => call.split(':')[0])).toEqual(['claim', 'send', 'release']);
      const receipt = db
        .prepare(
          `SELECT state FROM telegram_report_context_events
            WHERE delivery_id = ?`
        )
        .get(prepared!.deliveryId) as { state: string };
      expect(receipt.state).toBe('delivered');
      expect(pending?.request).toBeUndefined();
      expect(pending?.delivery).toBeUndefined();
    } finally {
      db.close();
      rmSync(mamaHome, { recursive: true, force: true });
    }
  });

  it('rejects wiring the legacy output sink beside the coordinator port', () => {
    const port = new FakePort();
    expect(
      () =>
        new OperatorTriggerLoop({
          delta: new FakeDelta(),
          memory: fakeMem(),
          registry: new TriggerRegistry(new Database(':memory:')),
          askAgent: async () => '[]',
          review: async () => ({ action: 'kept' as const }),
          reportDelivery: port,
          reportTarget: TARGET,
          output: { send: async () => {} },
          config: {
            tickMs: 60_000,
            drainLimit: 50,
            authorEveryNTicks: 99,
            reviewEveryNTicks: 99,
            authorWindowSize: 10,
          },
          log: () => {},
        })
    ).toThrow(/cannot run beside/i);
  });

  it('requires a report target with the port', () => {
    expect(
      () =>
        new OperatorTriggerLoop({
          delta: new FakeDelta(),
          memory: fakeMem(),
          registry: new TriggerRegistry(new Database(':memory:')),
          askAgent: async () => '[]',
          review: async () => ({ action: 'kept' as const }),
          reportDelivery: new FakePort(),
          config: {
            tickMs: 60_000,
            drainLimit: 50,
            authorEveryNTicks: 99,
            reviewEveryNTicks: 99,
            authorWindowSize: 10,
          },
          log: () => {},
        })
    ).toThrow(/requires reportTarget/i);
  });

  it('delivers a digest through the port and resets the window only on delivered', async () => {
    const port = new FakePort();
    const { loop, delta, pendingState } = harness(port);
    delta.queue = [ev(1, 'owner', 'pending owner update')];

    await loop.tick();

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].mode).toBe('digest');
    expect(port.calls[0].target).toEqual(TARGET);
    expect(pendingState()?.digest.windowTotal).toBe(0);
    expect(pendingState()?.delivery).toBeUndefined();
  });

  it('retains the pending artifact on retry_scheduled and resubmits the SAME delivery ID', async () => {
    const port = new FakePort();
    port.outcome = { status: 'retry_scheduled', nextAttemptAt: '2026-08-06T15:00:00.000Z' };
    const { loop, delta, logs, scheduler, pendingState } = harness(port);
    delta.queue = [ev(1, 'owner', 'pending owner update')];

    await loop.tick();

    expect(port.calls).toHaveLength(1);
    const firstDeliveryId = port.calls[0].deliveryId;
    expect(pendingState()?.delivery?.deliveryId).toBe(firstDeliveryId);
    expect(pendingState()?.digest.windowTotal).toBeGreaterThan(0);
    expect(scheduler.state.success).toHaveLength(0);
    expect(logs.join('\n')).toContain('retry scheduled');

    await loop.tick();

    expect(port.calls.length).toBeGreaterThanOrEqual(2);
    expect(port.calls.at(-1)?.deliveryId).toBe(firstDeliveryId);
  });

  it('skips the scheduled full leg while a delivery is outstanding instead of throwing', async () => {
    const port = new FakePort();
    port.outcome = { status: 'retry_scheduled', nextAttemptAt: '2026-08-06T15:00:00.000Z' };
    const { loop, delta, scheduler } = harness(port, { scheduledFire: true });
    delta.queue = [ev(1, 'owner', 'pending owner update')];

    await loop.tick();
    // The digest is parked as retry_scheduled; the scheduled full hour fires
    // on the next tick and must be SKIPPED, not thrown, while the pending
    // delivery is outstanding - and the hour must not be consumed.
    await loop.tick();

    expect(scheduler.state.fired).toEqual([]);
    expect(scheduler.state.success).toEqual([]);
  });

  it('degrades loudly on capacity_full without aborting the tick or losing the artifact', async () => {
    const port = new FakePort();
    port.outcome = { status: 'capacity_full', reason: 'capacity_full: live rows at cap' };
    const { loop, delta, logs, pendingState } = harness(port);
    delta.queue = [ev(1, 'owner', 'pending owner update')];

    const result = await loop.tick();

    expect(result.drained).toBe(1);
    expect(pendingState()?.delivery).toBeDefined();
    expect(logs.join('\n')).toContain('BLOCKED');

    // The next tick still drains deltas - the loop is not wedged.
    delta.queue = [ev(2, 'owner', 'later update')];
    const second = await loop.tick();
    expect(second.drained).toBe(1);
  });

  it('keeps the artifact on definite rejection without any credit', async () => {
    const port = new FakePort();
    port.outcome = { status: 'definite_rejection', reason: 'bot blocked' };
    const { loop, delta, logs, scheduler, pendingState } = harness(port);
    delta.queue = [ev(1, 'owner', 'pending owner update')];

    await loop.tick();

    expect(pendingState()?.delivery).toBeDefined();
    expect(scheduler.state.success).toHaveLength(0);
    expect(logs.join('\n')).toContain('definitively rejected');
  });

  it('clears the artifact on cancellation with an audit line and no credit', async () => {
    const port = new FakePort();
    port.outcome = { status: 'cancelled', reason: 'owner changed the report chat' };
    const { loop, delta, logs, scheduler, pendingState } = harness(port);
    delta.queue = [ev(1, 'owner', 'pending owner update')];

    await loop.tick();

    expect(pendingState()?.delivery).toBeUndefined();
    expect(scheduler.state.success).toHaveLength(0);
    expect(logs.join('\n')).toContain('cancelled without credit');

    port.outcome = { status: 'delivered' };
    await loop.tick();
    // The cancelled occurrence is gone; nothing is resubmitted for it.
    expect(port.calls.filter((c) => c.deliveryId === port.calls[0].deliveryId)).toHaveLength(1);
  });
});
