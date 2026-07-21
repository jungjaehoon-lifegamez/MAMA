import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type {
  AgentLoopOptions,
  GatewayToolExecutionContext,
  MAMAApiSetInput,
} from '../../src/agent/types.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger, type TaskRecord } from '../../src/operator/task-ledger.js';
import type {
  TemporalReconcileInput,
  TemporalWorkContext,
} from '../../src/operator/temporal-effect.js';
import { TemporalReconcileScheduler } from '../../src/operator/temporal-reconcile.js';
import { buildTemporalWorkerContext } from '../../src/operator/temporal-worker.js';
import {
  WorkOrderConsumer,
  type WorkOrderConsumerEvent,
} from '../../src/operator/workorder-consumer.js';
import { buildTemporalWorkOrderHook } from '../../src/operator/workorder-hooks.js';
import type { WorkerRunnerOptions } from '../../src/operator/worker-run.js';
import { buildWorkOrderAgentPolicy } from '../../src/cli/commands/start.js';
import { makeAuthorityHarness } from '../envelope/fixtures.js';
import type { EnvelopeAuthority } from '../../src/envelope/authority.js';

type ModelAction = (
  context: GatewayToolExecutionContext,
  trusted: TemporalWorkContext
) => Promise<string>;

interface FakeEvidence {
  source: 'trello';
  finding: 'completed' | 'inconclusive' | 'ambiguous_due' | 'unambiguous_due';
  summary: string;
  dueAt?: string;
}

const KST = 'Asia/Seoul';
const at = (time: string): number => Date.parse(`2026-07-21T${time}+09:00`);

describe('Story A2 Task 12: temporal workorder vertical slice', () => {
  let db: SQLiteDatabase;
  let now: number;
  let ledger: TaskLedger;
  let executor: GatewayToolExecutor;
  let scheduler: TemporalReconcileScheduler;
  let consumer: WorkOrderConsumer;
  let actions: ModelAction[];
  let runs: number[];
  let events: WorkOrderConsumerEvent[];
  let alarms: string[];
  let reports: Array<Record<string, string>>;
  let evidenceReads: Array<{ taskId: number; evidence: FakeEvidence }>;
  let envelopeAuthority: EnvelopeAuthority;
  let temporaryRoot: string | null;
  let previousLegacyBypass: string | undefined;

  beforeEach(() => {
    now = at('13:50:00');
    db = new Database(':memory:');
    actions = [];
    runs = [];
    events = [];
    alarms = [];
    reports = [];
    evidenceReads = [];
    temporaryRoot = null;
    previousLegacyBypass = process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
    process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS = 'false';
    configureRuntime();
  });

  afterEach(() => {
    db.close();
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    if (previousLegacyBypass === undefined) {
      delete process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
    } else {
      process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS = previousLegacyBypass;
    }
  });

  function configureRuntime(): void {
    ledger = new TaskLedger(db, { now: () => now, timeZone: KST });
    executor = new GatewayToolExecutor({
      temporalContextPacketLookup: async ({ packetId }) => ({
        packet_id: packetId,
        packet_json: JSON.stringify({ packet_id: packetId, selected_evidence: ['synthetic'] }),
        source_refs: [{ kind: 'raw', connector: 'trello', raw_id: 'synthetic-evidence' }],
        created_at: now,
      }),
    });
    executor.setTaskLedger(ledger);
    executor.setMamaApi({
      listDecisions: async () => [],
      appendToolTrace: async () => ({}) as never,
    } as unknown as MAMAApiSetInput);
    executor.setReportPublisher((slots) => reports.push(slots));
    envelopeAuthority = makeAuthorityHarness(db).authority;
    scheduler = new TemporalReconcileScheduler({ ledger, now: () => now, timeZone: KST });
    consumer = createConsumer();
  }

  function createConsumer(): WorkOrderConsumer {
    const nextConsumer = new WorkOrderConsumer({
      ledger,
      runner: {
        runWithContent: async (_content, options) => runModelAction(options),
      },
      loadBrief: () => 'Reconcile one temporal owner task through the trusted gateway.',
      runOptionsFor: (workOrder) => {
        const policy = buildWorkOrderAgentPolicy('temporal', 'test-worker-model', 'codex');
        return {
          workorderAttemptId: workOrder.id,
          temporalWorkContext: buildTemporalWorkerContext(ledger, workOrder),
          agentContext: policy.agentContext,
          envelope: envelopeAuthority.buildAndPersist({
            agent_id: 'workorder-temporal',
            instance_id: `temporal-attempt-${workOrder.id}`,
            source: 'watch',
            channel_id: 'worker:temporal',
            trigger_context: { user_text: `<temporal workorder #${workOrder.id}>` },
            scope: {
              project_refs: [{ kind: 'project', id: '/workspace/MAMA' }],
              raw_connectors: ['trello', 'kagemusha'],
              memory_scopes: [{ kind: 'project', id: '/workspace/MAMA' }],
              allowed_destinations: [{ kind: 'dashboard_slot', id: 'pipeline' }],
            },
            tier: 2,
            budget: { wall_seconds: 60 },
            expires_at: new Date(Date.now() + 90_000).toISOString(),
          }),
        };
      },
      noticeOwner: () => {},
      opsAlarm: {
        configured: true,
        send: async (line) => void alarms.push(line),
      },
      onEvent: (event) => events.push(event),
      now: () => now,
      log: () => {},
    });
    nextConsumer.registerHook(
      'temporal',
      buildTemporalWorkOrderHook({
        loadTemporalWorkContext: (attemptId) => ledger.loadTemporalWorkContext(attemptId),
        getTemporalEffect: (attemptId) => ledger.getTemporalEffect(attemptId),
        getTask: (taskId) => ledger.getById(taskId),
        getTemporalGeneration: (generationKey) => ledger.getTemporalGeneration(generationKey),
        getScopedNoteMaxId: (scope) => ledger.maxNoUpdateId(scope),
      })
    );
    return nextConsumer;
  }

  async function runModelAction(options: WorkerRunnerOptions): Promise<{ response: string }> {
    const trusted = options.temporalWorkContext as TemporalWorkContext | undefined;
    if (!trusted) throw new Error('fake model transport did not receive trusted temporal context');
    const executionContext = buildAgentToolExecutionContext(
      options as AgentLoopOptions
    ) as GatewayToolExecutionContext | null;
    if (!executionContext)
      throw new Error('fake model transport could not build execution context');
    executionContext.modelRunId = `mr_temporal_attempt_${trusted.attemptId}`;
    const action = actions.shift();
    if (!action) throw new Error('fake model response was not configured');
    runs.push(trusted.attemptId);
    return { response: await action(executionContext, trusted) };
  }

  function createExact(title = 'Confirm the 14:00 meeting outcome'): TaskRecord {
    return ledger.create({
      title,
      due_at: '2026-07-21T14:00:00+09:00',
      source_channel: 'trello:board-148',
      source_event_id: `card-${title}`,
    });
  }

  function readEvidence(context: TemporalWorkContext, evidence: FakeEvidence): FakeEvidence {
    evidenceReads.push({ taskId: context.taskId, evidence });
    return evidence;
  }

  function reconcile(
    evidence: FakeEvidence,
    input: (context: TemporalWorkContext, evidence: FakeEvidence) => TemporalReconcileInput
  ): ModelAction {
    return async (executionContext, trusted) => {
      const observed = readEvidence(trusted, evidence);
      await executor.execute(
        'task_temporal_reconcile',
        {
          context_packet_id: `ctxp_temporal_attempt_${trusted.attemptId}`,
          ...input(trusted, observed),
        },
        executionContext
      );
      return 'Reconciliation committed.';
    };
  }

  function countTemporalRows(): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM operator_tasks
           WHERE kind = 'system' AND source_channel = 'workorder:temporal'`
        )
        .get() as { count: number }
    ).count;
  }

  it('enqueues once at exactly 14:00 and completes only from a gateway receipt', async () => {
    const task = createExact();

    expect(scheduler.tick()).toEqual({ enqueued: 0, saturated: false });
    expect(ledger.countOpenWorkOrders('temporal')).toBe(0);

    now = at('14:00:00');
    expect(scheduler.tick()).toEqual({ enqueued: 1, saturated: false });
    expect(scheduler.tick()).toEqual({ enqueued: 0, saturated: false });
    expect(countTemporalRows()).toBe(1);

    actions.push(
      reconcile(
        {
          source: 'trello',
          finding: 'completed',
          summary: 'The scoped card activity confirms the meeting completed.',
        },
        (context, evidence) => ({
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'done',
          reason: evidence.summary,
        })
      )
    );
    await consumer.tick();

    const attemptId = runs[0]!;
    expect(ledger.getById(task.id)).toMatchObject({ status: 'done', revision: 2 });
    expect(ledger.getTemporalEffect(attemptId)).toMatchObject({
      taskId: task.id,
      outcome: 'resolved',
      changedFields: expect.arrayContaining(['status']),
    });
    expect(ledger.inspectTemporalAttempt(attemptId).workOrder.status).toBe('done');
    expect(events).toContainEqual({
      type: 'complete',
      workKind: 'temporal',
      workOrderId: attemptId,
    });
    expect(evidenceReads).toEqual([
      {
        taskId: task.id,
        evidence: expect.objectContaining({ source: 'trello', finding: 'completed' }),
      },
    ]);
  });

  it.each([
    [
      'explanation-only',
      async () => 'I inspected the evidence and would leave the task unchanged.',
    ],
    [
      'report-only',
      async (executionContext: GatewayToolExecutionContext) => {
        const result = await executor.execute(
          'report_publish',
          { slots: { pipeline: '<p>Observed, but did not reconcile.</p>' } },
          executionContext
        );
        expect(result).toMatchObject({ success: false, code: 'permission_denied' });
        expect(reports).toEqual([]);
        return 'Report publication was denied.';
      },
    ],
    ['empty', async () => '   '],
    [
      'denied',
      async (executionContext: GatewayToolExecutionContext, trusted: TemporalWorkContext) => {
        const missingEnvelope = { ...executionContext };
        delete missingEnvelope.envelope;
        const result = await executor.execute(
          'task_temporal_reconcile',
          {
            expected_revision: trusted.revision,
            outcome: 'resolved',
            status: 'done',
            reason: 'An envelope-less write must be denied.',
          },
          missingEnvelope
        );
        expect(result).toMatchObject({ success: false, code: 'envelope_missing' });
        return 'The write was denied by the production envelope boundary.';
      },
    ],
  ] satisfies Array<[string, ModelAction]>)(
    'retries a %s attempt with no receipt',
    async (_name, action) => {
      createExact();
      now = at('14:00:00');
      scheduler.tick();
      actions.push(action);

      await consumer.tick();

      const failedAttemptId = runs[0]!;
      expect(ledger.getTemporalEffect(failedAttemptId)).toBeNull();
      expect(ledger.inspectTemporalAttempt(failedAttemptId)).toMatchObject({
        workOrder: { status: 'failed', payload: { attempts: 1 } },
        generation: { disposition: 'active' },
      });
      expect(ledger.countOpenWorkOrders('temporal')).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'requeued', workKind: 'temporal' })
      );
    }
  );

  it('creates a new occurrence after reschedule and denies the old late write without alarm', async () => {
    const task = createExact();
    now = at('14:00:00');
    scheduler.tick();
    actions.push(async (executionContext, trusted) => {
      const updated = ledger.update(task.id, { due_at: '2026-07-21T15:00:00+09:00' });
      expect(updated.temporalEpoch).toBe(trusted.temporalEpoch + 1);
      await expect(
        executor.execute(
          'task_temporal_reconcile',
          {
            expected_revision: trusted.revision,
            outcome: 'resolved',
            status: 'done',
            reason: 'This old write must not commit.',
          },
          executionContext
        )
      ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
      return 'The stale write was rejected.';
    });

    await consumer.tick();

    expect(ledger.getById(task.id)).toMatchObject({
      status: 'pending',
      dueAt: at('15:00:00'),
      temporalEpoch: task.temporalEpoch + 1,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'superseded', workKind: 'temporal' })
    );
    expect(events.some((event) => event.type === 'requeued')).toBe(false);
    expect(alarms).toHaveLength(0);

    now = at('14:59:59');
    expect(scheduler.tick().enqueued).toBe(0);
    now = at('15:00:00');
    expect(scheduler.tick().enqueued).toBe(1);
    expect(countTemporalRows()).toBe(2);
  });

  it('schedules a deferred result as a distinct future generation', async () => {
    createExact();
    now = at('14:00:00');
    scheduler.tick();
    actions.push(
      reconcile(
        {
          source: 'trello',
          finding: 'inconclusive',
          summary: 'The authoritative meeting record is not final yet.',
        },
        (context, evidence) => ({
          expected_revision: context.revision,
          outcome: 'deferred',
          next_temporal_check_at: '2026-07-21T14:30:00+09:00',
          reason: evidence.summary,
        })
      )
    );
    await consumer.tick();
    const firstAttempt = runs[0]!;
    const firstGeneration = ledger.inspectTemporalAttempt(firstAttempt).generation;
    expect(firstGeneration.disposition).toBe('deferred');

    now = at('14:29:59');
    expect(scheduler.tick().enqueued).toBe(0);
    now = at('14:30:00');
    expect(scheduler.tick().enqueued).toBe(1);
    const secondAttempt = ledger.claimNextWorkOrder()!;
    expect(secondAttempt.payload.generationKey).not.toBe(firstGeneration.generationKey);
    expect(secondAttempt.payload.checkAt).toBe(at('14:30:00'));
  });

  it('recovers a pre-transaction crash once and does not rerun a committed transaction', async () => {
    db.close();
    temporaryRoot = mkdtempSync(join(tmpdir(), 'mama-temporal-restart-'));
    const databasePath = join(temporaryRoot, 'operator.db');
    db = new Database(databasePath);
    configureRuntime();

    const task = createExact();
    now = at('14:00:00');
    scheduler.tick();
    const stale = ledger.claimNextWorkOrder()!;

    db.close();
    db = new Database(databasePath);
    configureRuntime();
    consumer.bootRecover();
    expect(ledger.inspectTemporalAttempt(stale.id).workOrder.status).toBe('failed');
    expect(ledger.countOpenWorkOrders('temporal')).toBe(1);
    expect(countTemporalRows()).toBe(2);
    expect(scheduler.tick().enqueued).toBe(0);

    actions.push(
      reconcile(
        {
          source: 'trello',
          finding: 'completed',
          summary: 'Recovery retry found conclusive evidence.',
        },
        (context, evidence) => ({
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'done',
          reason: evidence.summary,
        })
      )
    );
    await consumer.tick();
    const committedAttempt = runs[0]!;
    expect(ledger.getById(task.id)?.status).toBe('done');

    const runCount = runs.length;
    db.close();
    db = new Database(databasePath);
    configureRuntime();
    consumer.bootRecover();
    await consumer.tick();
    expect(runs).toHaveLength(runCount);
    expect(scheduler.tick().enqueued).toBe(0);
    expect(ledger.inspectTemporalAttempt(committedAttempt).workOrder.status).toBe('done');
  });

  it('enriches date-only precision only when an explicit offset makes the due instant unambiguous', async () => {
    const task = ledger.create({
      title: 'Date-only delivery',
      deadline: '2026-07-21',
      source_channel: 'trello:board-148',
      source_event_id: 'card-date-only',
    });
    now = at('09:00:00');
    scheduler.tick();
    actions.push(
      reconcile(
        {
          source: 'trello',
          finding: 'ambiguous_due',
          summary: 'The source says 18:00 but supplies no time zone.',
        },
        (context, evidence) => ({
          expected_revision: context.revision,
          outcome: 'deferred',
          next_temporal_check_at: '2026-07-21T09:01:00+09:00',
          reason: `${evidence.summary} Preserve date-only precision pending clarification.`,
        })
      )
    );
    await consumer.tick();
    expect(ledger.getById(task.id)).toMatchObject({ dueAt: null, deadlineIso: '2026-07-21' });
    expect(ledger.countOpenWorkOrders('temporal')).toBe(0);
    expect(evidenceReads.at(-1)?.evidence.finding).toBe('ambiguous_due');

    now = at('09:01:00');
    expect(scheduler.tick().enqueued).toBe(1);

    actions.push(
      reconcile(
        {
          source: 'trello',
          finding: 'unambiguous_due',
          summary: 'The source now includes both the time and its UTC offset.',
          dueAt: '2026-07-21T18:00:00+09:00',
        },
        (context, evidence) => {
          if (!evidence.dueAt) throw new Error('unambiguous evidence must carry dueAt');
          return {
            expected_revision: context.revision,
            outcome: 'resolved',
            due_at: evidence.dueAt,
            reason: evidence.summary,
          };
        }
      )
    );
    await consumer.tick();
    expect(ledger.getById(task.id)).toMatchObject({
      dueAt: at('18:00:00'),
      deadlineOffsetMinutes: 540,
    });
    expect(evidenceReads.map((read) => read.evidence.finding)).toEqual([
      'ambiguous_due',
      'unambiguous_due',
    ]);
  });

  it('exhausts after three failures and repeated scans never create attempt four', async () => {
    createExact();
    now = at('14:00:00');
    scheduler.tick();

    for (let attempt = 1; attempt <= 3; attempt++) {
      actions.push(async () => `Explanation-only failure ${attempt}`);
      await consumer.tick();
    }

    expect(runs).toHaveLength(3);
    expect(countTemporalRows()).toBe(3);
    const exhausted = ledger.inspectTemporalAttempt(runs[2]!).generation;
    expect(exhausted.disposition).toBe('exhausted');
    expect(ledger.countOpenWorkOrders('temporal')).toBe(0);
    expect(alarms.some((line) => line.includes('retries exhausted'))).toBe(true);

    for (let scan = 0; scan < 5; scan++) expect(scheduler.tick().enqueued).toBe(0);
    expect(countTemporalRows()).toBe(3);
  });

  it('protects exact/deferred work with per-scan and ten-open backlog caps', () => {
    const deferredTask = ledger.create({
      title: 'Deferred backlog priority',
      due_at: '2026-07-21T13:45:00+09:00',
      source_channel: 'trello:board-148',
      source_event_id: 'deferred-backlog',
    });
    expect(scheduler.tick().enqueued).toBe(1);
    const deferredAttempt = ledger.claimNextWorkOrder()!;
    const deferredContext = ledger.loadTemporalWorkContext(deferredAttempt.id);
    ledger.applyTemporalEffect(
      deferredContext,
      {
        expected_revision: deferredContext.revision,
        outcome: 'deferred',
        next_temporal_check_at: '2026-07-21T14:00:00+09:00',
        reason: 'The exact evidence check must resume at 14:00.',
      },
      {
        contextPacketId: 'ctxp_temporal_backlog_test',
        contextPacketSha256: 'c'.repeat(64),
      }
    );

    for (let index = 0; index < 6; index++) {
      createExact(`Exact backlog ${index}`);
    }
    for (let index = 0; index < 4; index++) {
      ledger.create({
        title: `Date backlog ${index}`,
        deadline: '2026-07-21',
        source_channel: 'trello:board-148',
        source_event_id: `date-backlog-${index}`,
      });
    }
    now = at('14:00:00');

    expect(scheduler.tick()).toEqual({ enqueued: 5, saturated: false });
    expect(ledger.countOpenWorkOrders('temporal')).toBe(5);
    const priorities = db
      .prepare(
        `SELECT priority, json_extract(payload, '$.taskId') AS task_id FROM operator_tasks
         WHERE kind = 'system' AND source_channel = 'workorder:temporal'
           AND status IN ('pending', 'in_progress')
         ORDER BY id`
      )
      .all() as Array<{ priority: string; task_id: number }>;
    expect(priorities.filter((row) => row.priority === 'high')).toHaveLength(4);
    expect(priorities.filter((row) => row.priority === 'normal')).toHaveLength(1);
    expect(priorities.some((row) => row.task_id === deferredTask.id)).toBe(true);

    expect(scheduler.tick()).toEqual({ enqueued: 4, saturated: false });
    expect(ledger.countOpenWorkOrders('temporal')).toBe(9);
    expect(scheduler.tick()).toEqual({ enqueued: 1, saturated: false });
    expect(ledger.countOpenWorkOrders('temporal')).toBe(10);
    expect(scheduler.tick()).toEqual({ enqueued: 0, saturated: true });
    expect(ledger.countOpenWorkOrders('temporal')).toBe(10);
  });
});
