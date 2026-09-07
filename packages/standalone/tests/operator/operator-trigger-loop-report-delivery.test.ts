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
import { AgentLoop } from '../../src/agent/agent-loop.js';
import type {
  BeginModelRunInput,
  MAMAApiInterface,
  ModelRunRecord,
} from '../../src/agent/types.js';
import type { PromptOptions } from '../../src/agent/model-runner.js';
import { buildOperatorReportAgentPolicy } from '../../src/cli/commands/start.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
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
import {
  FilePendingReportStore,
  type PendingReportDelivery,
  type PendingReportState,
} from '../../src/operator/pending-report-store.js';
import { createPersonaReportAsk } from '../../src/operator/report-run.js';
import { OWNER_RUNTIME_SESSION_KEY } from '../../src/operator/owner-runtime.js';

const { codexPromptMock } = vi.hoisted(() => ({
  codexPromptMock: vi.fn(),
}));

vi.mock('../../src/multi-agent/runtime-process.js', () => ({
  CodexRuntimeProcess: vi.fn().mockImplementation(() => ({
    prompt: codexPromptMock,
    getSessionPolicyStatus: vi.fn().mockReturnValue('compatible'),
    setSystemPrompt: vi.fn(),
    setSessionId: vi.fn(),
    stop: vi.fn(),
  })),
}));

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
    reportAsk: createPersonaReportAsk({
      run: async (_prompt, sourceMessageRef) => {
        expect(pending?.request?.mode).toBe('digest');
        expect(sourceMessageRef).toBe(`owner-report:${pending?.request?.deliveryId}`);
        return { response: 'owner digest body\nUSED_TRIGGERS: none', history: [] };
      },
      log: () => {},
    }),
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
  it('TG-05/TG-06 resumes a persisted digest occurrence after a model failure without repeating delivered work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mama-digest-recovery-'));
    const storePath = join(directory, 'pending.json');
    const db = new Database(':memory:');
    const port = new FakePort();
    const refs: string[] = [];
    const makeLoop = (fail: boolean, delta: FakeDelta) =>
      new OperatorTriggerLoop({
        delta,
        memory: fakeMem(),
        registry: new TriggerRegistry(db),
        askAgent: async () => '[]',
        reportAsk: createPersonaReportAsk({
          run: async (_prompt, ref) => {
            const state = new FilePendingReportStore(storePath).load();
            expect(state).not.toBeNull();
            if (!state) throw new Error('missing persisted request');
            expect(state.request?.mode).toBe('digest');
            expect(ref).toBe(`owner-report:${state.request?.deliveryId}`);
            refs.push(ref!);
            if (fail) throw new Error('model interrupted');
            return { response: 'current digest\nUSED_TRIGGERS: none', history: [] };
          },
          log: () => {},
        }),
        review: async () => ({ action: 'kept' as const }),
        reportDelivery: port,
        reportTarget: TARGET,
        pendingReportStore: new FilePendingReportStore(storePath),
        config: {
          tickMs: 60000,
          drainLimit: 50,
          authorEveryNTicks: 99,
          reviewEveryNTicks: 99,
          authorWindowSize: 10,
          reportEveryNTicks: 1,
        },
        log: () => {},
      });
    try {
      const delta = new FakeDelta();
      delta.queue.push(ev(1, 'project', 'deadline changed'));
      await expect(makeLoop(true, delta).tick()).rejects.toThrow('model interrupted');
      expect(port.calls).toHaveLength(0);
      const recovered = makeLoop(false, new FakeDelta());
      await recovered.tick();
      await recovered.tick();
      expect(refs).toHaveLength(2);
      expect(refs[0]).toBe(refs[1]);
      expect(port.calls).toHaveLength(1);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('TG-01/TG-03/TG-04/TG-05/TG-06 carries one scoped full-report turn through a durable delivered receipt', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-full-report-e2e-'));
    const pendingPath = join(mamaHome, 'pending-report.json');
    const receiptPath = join(mamaHome, 'messenger.db');
    const pendingStore = new FilePendingReportStore(pendingPath);
    const db = new Database(receiptPath);
    const reportStore = new TelegramReportContextStore(db);
    const claimedDeliveryIds: string[] = [];
    const sentDeliveryIds: string[] = [];
    const releasedDeliveryIds: string[] = [];
    const deliveryControl: TelegramReportDeliveryControl = {
      async claimAndPin(binding: ReportDeliveryBinding): Promise<ReportDeliveryLease> {
        claimedDeliveryIds.push(binding.deliveryId);
        return { deliveryId: binding.deliveryId };
      },
      async sendPinned(lease: ReportDeliveryLease) {
        sentDeliveryIds.push(lease.deliveryId);
        return { kind: 'confirmed' as const };
      },
      async releasePin(deliveryId: string): Promise<void> {
        releasedDeliveryIds.push(deliveryId);
      },
      async reconcilePins(): Promise<void> {},
    };
    const coordinator = new ReportDeliveryCoordinator({
      store: reportStore,
      control: deliveryControl,
      ownerTarget: TARGET,
      executorId: 'offline-e2e',
      nowIso: () => '2026-09-02T00:00:00.000Z',
      mamaHome,
    });
    let prepared: PendingReportDelivery | undefined;
    const delivery: ReportDeliveryPort = {
      async deliverPrepared(report) {
        prepared = structuredClone(report);
        return coordinator.deliverPrepared(report);
      },
    };
    const modelRunInputs: BeginModelRunInput[] = [];
    const modelRunRecord = (
      status: ModelRunRecord['status'],
      inputRefs: Record<string, unknown> | null,
      completedAt: number | null
    ): ModelRunRecord => ({
      model_run_id: 'offline-model-run',
      model_id: 'gpt-5.6-luna',
      model_provider: 'codex',
      prompt_version: null,
      tool_manifest_version: null,
      output_schema_version: null,
      agent_id: 'operator_report',
      instance_id: OWNER_RUNTIME_SESSION_KEY,
      envelope_hash: null,
      parent_model_run_id: null,
      input_snapshot_ref: null,
      input_refs_json: inputRefs === null ? null : JSON.stringify(inputRefs),
      input_refs: inputRefs,
      completion_summary: status === 'committed' ? 'Grounded owner report' : null,
      status,
      error_summary: status === 'failed' ? 'test failure' : null,
      token_count: 0,
      cost_estimate: null,
      created_at: Date.parse('2026-09-02T00:00:00.000Z'),
      completed_at: completedAt,
    });
    let activeInputRefs: Record<string, unknown> | null = null;
    const appendToolTrace = vi.fn(async () => {
      throw new Error('packet-only owner reports must not append a tool trace');
    });
    const modelApi = {
      beginModelRun: vi.fn(async (input: BeginModelRunInput) => {
        modelRunInputs.push(structuredClone(input));
        activeInputRefs = input.input_refs ?? null;
        return modelRunRecord('running', activeInputRefs, null);
      }),
      commitModelRun: vi.fn(async () =>
        modelRunRecord('committed', activeInputRefs, Date.parse('2026-09-02T00:00:01.000Z'))
      ),
      failModelRun: vi.fn(async () =>
        modelRunRecord('failed', activeInputRefs, Date.parse('2026-09-02T00:00:01.000Z'))
      ),
      appendToolTrace,
    } as unknown as MAMAApiInterface;
    const privateConnectorPolicy = resolvePrivateConnectorPolicy({
      ok: true,
      config: {},
      enabledNames: [],
    });
    const reportPolicy = buildOperatorReportAgentPolicy(
      'gpt-5.6-luna',
      'codex',
      privateConnectorPolicy
    );
    expect(reportPolicy.agentContext.role.allowedTools).toContain('task_list');
    expect(reportPolicy.agentContext.role.allowedTools).toContain('changes_read');
    expect(reportPolicy.gatewayToolsPrompt).toContain('task_list');
    const agentLoop = new AgentLoop(
      null,
      {
        backend: 'codex',
        model: 'gpt-5.6-luna',
        systemPrompt: 'Compose the owner report only from the supplied packet.',
        useCodeAct: true,
        toolsConfig: { gateway: ['*'], mcp: [] },
        codexCwd: mamaHome,
      },
      {},
      { mamaApi: modelApi }
    );
    let admittedDeliveryId: string | undefined;
    codexPromptMock
      .mockReset()
      .mockImplementationOnce(
        async (prompt: string, _callbacks: unknown, options?: PromptOptions) => {
          // The durable request stores intent and delivery identity, not a bulk evidence dump.
          const admittedState = new FilePendingReportStore(pendingPath).load();
          const admittedRequest = admittedState?.request;
          admittedDeliveryId = admittedRequest?.deliveryId;
          expect(admittedDeliveryId).toBe('operator-report:scheduled:2026-09-02:00');
          expect(admittedRequest?.contextJson).toBeUndefined();
          expect(admittedRequest?.contextSha256).toBeUndefined();
          expect(modelRunInputs).toHaveLength(1);
          expect(modelRunInputs[0]?.input_refs?.sourceMessageRef).toBe(
            `owner-report:${admittedDeliveryId}`
          );
          expect(options?.hostToolBridge?.tools.map((tool) => tool.name)).toEqual(['code_act']);
          expect(prompt).toContain('Discover progressively');
          expect(options?.systemPrompt).toContain('tool_search');
          expect(options?.systemPrompt).not.toContain('declare function task_list');
          return {
            response: 'Grounded owner report',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'offline-report-session',
          };
        }
      );
    let composedProvenance:
      | { status: 'available'; modelRunId: string }
      | { status: 'unavailable'; reason: string }
      | undefined;
    const reportAsk = createPersonaReportAsk({
      run: async (prompt, sourceMessageRef) => {
        const result = await agentLoop.runWithContent([{ type: 'text', text: prompt }], {
          sessionKey: OWNER_RUNTIME_SESSION_KEY,
          source: 'operator',
          channelId: 'report',
          agentContext: reportPolicy.agentContext,
          sessionPolicyRole: DEFAULT_ROLES.definitions.owner_console,
          gatewayToolsPrompt: reportPolicy.gatewayToolsPrompt,
          ...(sourceMessageRef ? { sourceMessageRef } : {}),
        });
        return result;
      },
      log: () => {},
      onRunProvenance: (provenance) => {
        composedProvenance = provenance;
      },
    });
    const loop = new OperatorTriggerLoop({
      delta: new FakeDelta(),
      memory: fakeMem(),
      registry: new TriggerRegistry(db),
      askAgent: async () => '[]',
      reportAsk,
      fullReportProvenance: () => composedProvenance,
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
      pendingReportStore: pendingStore,
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

      expect(codexPromptMock).toHaveBeenCalledOnce();
      expect(modelRunInputs).toHaveLength(1);
      expect(appendToolTrace).not.toHaveBeenCalled();
      expect(prepared).toMatchObject({
        mode: 'full',
        text: 'Grounded owner report',
        provenance: { status: 'available', modelRunId: 'offline-model-run' },
      });
      expect(prepared!.deliveryId).toBe(admittedDeliveryId);
      expect(claimedDeliveryIds).toEqual([prepared!.deliveryId]);
      expect(sentDeliveryIds).toEqual([prepared!.deliveryId]);
      expect(releasedDeliveryIds).toEqual([prepared!.deliveryId]);
      const completedPendingState = new FilePendingReportStore(pendingPath).load();
      expect(completedPendingState?.version).toBe(1);
      expect(completedPendingState?.request).toBeUndefined();
      expect(completedPendingState?.delivery).toBeUndefined();

      db.close();
      const reopenedDb = new Database(receiptPath);
      const receipt = reopenedDb
        .prepare(
          `SELECT delivery_id, target, mode, occurrence, provenance, text,
                  payload_identity, state
             FROM telegram_report_context_events
            WHERE delivery_id = ?`
        )
        .get(prepared!.deliveryId) as {
        delivery_id: string;
        target: string;
        mode: string;
        occurrence: string;
        provenance: string;
        text: string;
        payload_identity: string;
        state: string;
      };
      expect(receipt).toEqual({
        delivery_id: prepared!.deliveryId,
        target: JSON.stringify([prepared!.target.source, prepared!.target.channelId]),
        mode: prepared!.mode,
        occurrence: JSON.stringify(prepared!.occurrence),
        provenance: JSON.stringify(prepared!.provenance),
        text: prepared!.text,
        payload_identity: prepared!.payloadIdentity,
        state: 'delivered',
      });
      reopenedDb.close();
    } finally {
      if (db.open) {
        db.close();
      }
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
    expect(logs.join('\n')).not.toContain('SENT');
    expect(logs.join('\n')).toContain('pending delivery');

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
