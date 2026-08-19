import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { GatewayToolExecutor } from '../../../src/agent/gateway-tool-executor.js';
import { initAgentTables } from '../../../src/db/agent-store.js';
import { createApiServer } from '../../../src/api/index.js';
import { DEFAULT_CONFIG, type MAMAConfig } from '../../../src/cli/config/types.js';
import { registerApiRoutes } from '../../../src/cli/runtime/api-routes-init.js';
import type { MAMAApiShape } from '../../../src/cli/runtime/types.js';
import type { ConnectorConfigLoadResult } from '../../../src/connectors/config-loader.js';
import { resolvePrivateConnectorPolicy } from '../../../src/connectors/private-connector-policy.js';
import type { MessageRouter } from '../../../src/gateways/index.js';
import { AgentEventBus } from '../../../src/multi-agent/agent-event-bus.js';
import type { ExternalLifecycleCandidateSet } from '../../../src/operator/external-lifecycle.js';
import {
  bindingCandidateFor,
  enqueueAndClaimBindingAttempt,
} from '../../operator/external-lifecycle-fixtures.js';
import { TaskLedger } from '../../../src/operator/task-ledger.js';
import { BoardRefreshGate } from '../../../src/operator/board-refresh-gate.js';
import { WorkOrderConsumer } from '../../../src/operator/workorder-consumer.js';
import { buildOwnerWorkOrderRequestHandler } from '../../../src/cli/commands/start.js';
import { CronScheduler } from '../../../src/scheduler/cron-scheduler.js';
import Database from '../../../src/sqlite.js';
import type { AgentLoop } from '../../../src/agent/index.js';
import type { OAuthManager } from '../../../src/auth/index.js';

const disabledConnectorConfig: ConnectorConfigLoadResult = {
  ok: true,
  config: {
    kagemusha: {
      enabled: false,
      pollIntervalMinutes: 60,
      channels: {},
      auth: { type: 'none' },
    },
  },
  enabledNames: [],
};

const enabledConnectorConfig: ConnectorConfigLoadResult = {
  ok: true,
  config: {
    kagemusha: {
      enabled: true,
      pollIntervalMinutes: 60,
      channels: {},
      auth: { type: 'none' },
    },
  },
  enabledNames: ['kagemusha'],
};

const malformedConnectorConfig: ConnectorConfigLoadResult = {
  ok: false,
  error: {
    code: 'parse_error',
    path: '/private/connectors.json',
    message: 'redacted from reconcile workorders',
  },
  config: {},
  enabledNames: [],
};

function createConfig(): MAMAConfig {
  return {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent },
    database: { ...DEFAULT_CONFIG.database },
    logging: { ...DEFAULT_CONFIG.logging },
    multi_agent: {
      enabled: true,
      loop_prevention: {
        max_chain_length: 3,
        global_cooldown_ms: 60,
        chain_window_ms: 60,
      },
      agents: {
        'dashboard-agent': {
          name: 'Dashboard',
          display_name: 'Dashboard',
          trigger_prefix: '@dashboard',
          persona_file: 'dashboard.md',
          enabled: true,
        },
      },
    },
  };
}

function createConnectorEventTable(db: Database): void {
  db.exec(`CREATE TABLE connector_event_index (
    event_index_id TEXT PRIMARY KEY,
    source_connector TEXT,
    source_type TEXT,
    source_id TEXT,
    channel TEXT,
    content_hash BLOB CHECK(length(content_hash) = 32),
    source_timestamp_ms INTEGER,
    operator_ingest_seq INTEGER,
    operator_observation_seq INTEGER,
    metadata_json TEXT
  )`);
}

function insertKagemushaEvent(
  db: Database,
  input: {
    eventId: string;
    sourceId?: string;
    channel?: string;
    status?: string;
    observationSeq?: number;
    metadata?: Readonly<Record<string, unknown>>;
  }
): void {
  db.prepare(`INSERT INTO connector_event_index VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.eventId,
    'kagemusha',
    'kanban_card',
    input.sourceId ?? 'task:42',
    input.channel ?? 'private-room',
    Buffer.from('a'.repeat(64), 'hex'),
    1_775_260_800_000,
    1,
    input.observationSeq ?? 1,
    JSON.stringify(
      input.metadata ?? {
        taskId: 42,
        status: input.status ?? 'done',
        rawConnector: 'kagemusha',
      }
    )
  );
}

async function registerReconcileRuntime(input: {
  db: Database;
  connectorConfigLoadResult: ConnectorConfigLoadResult;
  ledger?: TaskLedger;
  boardRefreshGate?: BoardRefreshGate | null;
  eventBus?: AgentEventBus;
  rawConnectorScope?: readonly string[];
  getAdapter?: () => { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } };
}): Promise<{
  apiServer: ReturnType<typeof createApiServer>;
  boardRefreshGate: BoardRefreshGate | null;
  eventBus: AgentEventBus;
  ledger: TaskLedger;
  routeHandle: { stop: () => void };
}> {
  const policy = resolvePrivateConnectorPolicy(input.connectorConfigLoadResult);
  const eventBus = input.eventBus ?? new AgentEventBus();
  const toolExecutor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    privateConnectorPolicy: policy,
  });
  const ledger = input.ledger ?? new TaskLedger(input.db);
  const boardRefreshGate =
    input.boardRefreshGate !== undefined
      ? input.boardRefreshGate
      : process.env.MAMA_BOARD_RECONCILE === '1'
        ? new BoardRefreshGate()
        : null;
  toolExecutor.setTaskLedger(ledger);
  const apiServer = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: input.connectorConfigLoadResult,
    privateConnectorPolicy: policy,
  });

  const routeHandle = await registerApiRoutes({
    config: createConfig(),
    apiServer,
    eventBus,
    oauthManager: {} as OAuthManager,
    mamaApi: {} as MAMAApiShape,
    messageRouter: {} as MessageRouter,
    agentLoop: {} as AgentLoop,
    toolExecutor,
    discordGateway: null,
    slackGateway: null,
    graphHandler: async () => false,
    privateConnectorPolicy: policy,
    rawConnectorScope: input.rawConnectorScope ?? input.connectorConfigLoadResult.enabledNames,
    boardRefreshGate,
    getAdapter: input.getAdapter ?? (() => input.db),
  });

  return { apiServer, boardRefreshGate, eventBus, ledger, routeHandle };
}

async function emitReconcileDelta(
  eventBus: AgentEventBus,
  eventId: string,
  channelKey = 'kagemusha:private-room'
): Promise<void> {
  eventBus.emit({
    type: 'operator:channel-delta',
    channelKey,
    lines: [`[id:${eventId}] host delta`],
    eventIds: [eventId],
  });
  await vi.advanceTimersByTimeAsync(1);
}

function lifecycleCandidates(workorder: ReturnType<TaskLedger['claimNextWorkOrder']>) {
  if (!workorder) throw new Error('reconcile workorder expected');
  return workorder.payload.candidates as unknown as ExternalLifecycleCandidateSet;
}

function bindExistingTask(ledger: TaskLedger): { taskId: number } {
  const task = ledger.create({ title: 'native task' });
  const candidate = bindingCandidateFor({ task });
  const attempt = enqueueAndClaimBindingAttempt(ledger, candidate);
  ledger.applyExternalBindingDecision(
    attempt.id,
    {
      candidate_id: candidate.candidateId,
      decision: 'bind',
      reason: 'exact task identity confirmed',
      expected_revision: candidate.taskRevision,
    },
    { runId: 'test_bind', workOrderAttemptId: attempt.id, causeEventIds: [candidate.eventId] }
  );
  return { taskId: task.id };
}

async function registerOwnerFullRuntime(effect: 'report' | 'no-update' | 'failed' | 'none') {
  const db = new Database(':memory:');
  initAgentTables(db);
  createConnectorEventTable(db);
  const policy = resolvePrivateConnectorPolicy(enabledConnectorConfig);
  const eventBus = new AgentEventBus();
  const toolExecutor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    privateConnectorPolicy: policy,
  });
  const ledger = new TaskLedger(db);
  const boardRefreshGate = new BoardRefreshGate({ initialGeneration: 500 });
  toolExecutor.setSessionsDb(db);
  toolExecutor.setTaskLedger(ledger);
  const apiServer = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: enabledConnectorConfig,
    privateConnectorPolicy: policy,
  });
  const consumer = new WorkOrderConsumer({
    ledger,
    runner: {
      runWithContent: async (_content, options) => {
        const context = {
          executionSurface: 'model_tool' as const,
          source: 'operator' as const,
          channelId: 'worker:board',
          workorderAttemptId: options.workorderAttemptId,
        };
        if (effect === 'report') {
          await toolExecutor.execute(
            'report_publish',
            {
              slots: {
                briefing: '<p>briefing</p>',
                action_required: '<p>action</p>',
                decisions: '<p>decisions</p>',
                pipeline: '<p>pipeline</p>',
              },
            } as never,
            context as never
          );
        } else if (effect === 'no-update') {
          const row = db
            .prepare(
              `SELECT payload FROM operator_tasks
               WHERE kind = 'system' AND status = 'in_progress'
               ORDER BY id ASC LIMIT 1`
            )
            .get() as { payload: string };
          const payload = JSON.parse(row.payload) as { noUpdateScope: string };
          await toolExecutor.execute(
            'contract_no_update',
            { reason: 'exact full repair found no changes', scope: payload.noUpdateScope } as never,
            context as never
          );
        } else if (effect === 'failed') {
          await toolExecutor
            .execute('report_publish', {} as never, context as never)
            .catch(() => undefined);
        }
        return { response: effect === 'none' ? 'DONE in prose only' : 'DONE' };
      },
    },
    loadBrief: () => 'Synthetic board worker brief',
    runOptionsFor: (workOrder) => ({ workorderAttemptId: workOrder.id }),
    noticeOwner: () => undefined,
    opsAlarm: { configured: false, send: async () => undefined },
  });

  await registerApiRoutes({
    config: createConfig(),
    apiServer,
    eventBus,
    oauthManager: {} as OAuthManager,
    mamaApi: {} as MAMAApiShape,
    messageRouter: {} as MessageRouter,
    agentLoop: {} as AgentLoop,
    toolExecutor,
    discordGateway: null,
    slackGateway: null,
    graphHandler: async () => false,
    privateConnectorPolicy: policy,
    rawConnectorScope: enabledConnectorConfig.enabledNames,
    getAdapter: () => db,
    sessionsDb: db,
    workOrderConsumer: consumer,
    boardRefreshGate,
  });
  const ownerRequest = buildOwnerWorkOrderRequestHandler({
    taskLedger: ledger,
    boardRefreshGate,
    now: () => 9_000,
  });
  return { apiServer, boardRefreshGate, consumer, db, eventBus, ledger, ownerRequest };
}

describe('TG-04 Task 7: registered reconcile callback private lifecycle isolation', () => {
  let testHome: string;
  let previousHome: string | undefined;
  let previousReconcile: string | undefined;
  let previousDebounce: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    testHome = mkdtempSync(join(tmpdir(), 'mama-api-routes-reconcile-'));
    previousHome = process.env.HOME;
    previousReconcile = process.env.MAMA_BOARD_RECONCILE;
    previousDebounce = process.env.MAMA_RECONCILE_DEBOUNCE_MS;
    process.env.HOME = testHome;
    process.env.MAMA_BOARD_RECONCILE = '1';
    process.env.MAMA_RECONCILE_DEBOUNCE_MS = '1';
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousReconcile === undefined) delete process.env.MAMA_BOARD_RECONCILE;
    else process.env.MAMA_BOARD_RECONCILE = previousReconcile;
    if (previousDebounce === undefined) delete process.env.MAMA_RECONCILE_DEBOUNCE_MS;
    else process.env.MAMA_RECONCILE_DEBOUNCE_MS = previousDebounce;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('does not turn disabled private historical evidence or delta prose into a board workorder', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      insertKagemushaEvent(db, { eventId: 'evt_private', sourceId: 'secret-source-id' });
      const { eventBus, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: disabledConnectorConfig,
      });

      eventBus.emit({
        type: 'operator:channel-delta',
        channelKey: 'kagemusha:private-room',
        lines: ['secret title and private lifecycle prose'],
        eventIds: ['evt_private'],
      });
      await vi.advanceTimersByTimeAsync(1);

      expect(ledger.claimNextWorkOrder()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('enqueues the enabled exact event payload with its host-built binding candidate', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      const ledger = new TaskLedger(db);
      const task = ledger.create({ title: 'native task', source_event_id: 'evt_enabled' });
      insertKagemushaEvent(db, { eventId: 'evt_enabled' });
      const { eventBus } = await registerReconcileRuntime({
        db,
        ledger,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await emitReconcileDelta(eventBus, 'evt_enabled');

      const workorder = ledger.claimNextWorkOrder();
      expect(workorder?.payload).toMatchObject({
        mode: 'reconcile',
        channelKey: 'kagemusha:private-room',
        eventIds: ['evt_enabled'],
        repairGeneration: expect.any(Number),
      });
      expect(lifecycleCandidates(workorder)).toMatchObject({
        bindingCandidates: [
          {
            eventId: 'evt_enabled',
            taskId: task.id,
            observedStatus: 'done',
          },
        ],
        lifecycleCandidates: [],
        diagnostics: [],
      });
    } finally {
      db.close();
    }
  });

  it('TG-06 enqueues one boot repair with an exact scope and dedupes it while open', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      const { ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      const bootRepair = ledger.claimNextWorkOrder();
      expect(bootRepair).toMatchObject({
        workKind: 'board',
        idempotencyKey: 'board:full:repair',
        payload: {
          mode: 'full',
          repairGeneration: expect.any(Number),
          noUpdateScope: expect.stringMatching(/^full:\d+$/),
        },
      });
      expect(bootRepair?.payload.noUpdateScope).toBe(
        `full:${String(bootRepair?.payload.repairGeneration)}`
      );

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(ledger.claimNextWorkOrder()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('TG-06 preserves the legacy 30-minute full schedule when reconcile is disabled', async () => {
    const db = new Database(':memory:');
    process.env.MAMA_BOARD_RECONCILE = '0';
    try {
      createConnectorEventTable(db);
      const { ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      const boot = ledger.claimNextWorkOrder();
      expect(boot?.payload).toEqual({ attempts: 1, mode: 'full' });
      if (!boot) throw new Error('legacy boot full expected');
      ledger.completeWorkOrder(boot.id);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(ledger.claimNextWorkOrder()?.payload.mode).toBe('full');
    } finally {
      process.env.MAMA_BOARD_RECONCILE = '1';
      db.close();
    }
  });

  it('TG-06 safely generation-binds an eventless manual reconcile', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      const { apiServer, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      const response = await request(apiServer.app)
        .post('/api/operator/reconcile')
        .send({
          channelKey: 'telegram:owner',
          lines: ['owner-requested manual reconcile'],
        });
      expect(response.status).toBe(200);
      await vi.advanceTimersByTimeAsync(1);

      expect(ledger.claimNextWorkOrder()?.payload).toMatchObject({
        mode: 'reconcile',
        channelKey: 'telegram:owner',
        eventIds: [],
        repairGeneration: expect.any(Number),
      });
    } finally {
      db.close();
    }
  });

  it.each(['report'] as const)(
    'TG-06 owner full %s effect clears shared dirt and suppresses scheduled repair',
    async (effect) => {
      const runtime = await registerOwnerFullRuntime(effect);
      try {
        expect(runtime.ownerRequest('board')).toEqual({ accepted: true });
        expect(runtime.boardRefreshGate.needsFullRepair()).toBe(true);

        await runtime.consumer.tick();

        expect(runtime.boardRefreshGate.needsFullRepair()).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000 + 30 * 60 * 1000);
        expect(runtime.ledger.claimNextWorkOrder()).toBeNull();
      } finally {
        runtime.db.close();
      }
    }
  );

  it.each(['no-update', 'none', 'failed'] as const)(
    'TG-06 owner full %s effect stays dirty and schedules one repair',
    async (effect) => {
      const runtime = await registerOwnerFullRuntime(effect);
      try {
        expect(runtime.ownerRequest('board', ['evt-owner-full'])).toEqual({ accepted: true });

        await runtime.consumer.tick();

        expect(runtime.boardRefreshGate.needsFullRepair()).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(runtime.ledger.claimNextWorkOrder()).toMatchObject({
          idempotencyKey: 'board:full:repair',
          payload: { mode: 'full' },
        });
        expect(runtime.ledger.claimNextWorkOrder()).toBeNull();
      } finally {
        runtime.db.close();
      }
    }
  );

  it('TG-06 forced agent refresh marks a new host generation before enqueue', async () => {
    const runtime = await registerOwnerFullRuntime('none');
    try {
      runtime.boardRefreshGate.completeVerifiedFull(500);
      expect(runtime.boardRefreshGate.needsFullRepair()).toBe(false);

      const response = await request(runtime.apiServer.app).post('/api/report/agent-refresh');

      expect(response.status).toBe(200);
      expect(runtime.boardRefreshGate.captureFullRepair()).toEqual({
        repairGeneration: 501,
        noUpdateScope: 'full:501',
      });
      expect(runtime.ledger.claimNextWorkOrder()?.payload).toMatchObject({
        mode: 'full',
        force: true,
        repairGeneration: 501,
        noUpdateScope: 'full:501',
      });
    } finally {
      runtime.db.close();
    }
  });

  it.each(['report'] as const)(
    'TG-06 forced agent refresh %s effect clears dirt and suppresses scheduled repair',
    async (effect) => {
      const runtime = await registerOwnerFullRuntime(effect);
      try {
        runtime.boardRefreshGate.completeVerifiedFull(500);
        await request(runtime.apiServer.app).post('/api/report/agent-refresh').expect(200);

        await runtime.consumer.tick();

        expect(runtime.boardRefreshGate.needsFullRepair()).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000 + 30 * 60 * 1000);
        expect(runtime.ledger.claimNextWorkOrder()).toBeNull();
      } finally {
        runtime.db.close();
      }
    }
  );

  it.each(['no-update', 'none', 'failed'] as const)(
    'TG-06 forced agent refresh %s effect stays dirty for scheduled repair',
    async (effect) => {
      const runtime = await registerOwnerFullRuntime(effect);
      try {
        runtime.boardRefreshGate.completeVerifiedFull(500);
        await request(runtime.apiServer.app).post('/api/report/agent-refresh').expect(200);

        await runtime.consumer.tick();

        expect(runtime.boardRefreshGate.needsFullRepair()).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(runtime.ledger.claimNextWorkOrder()).toMatchObject({
          idempotencyKey: 'board:full:repair',
          payload: { mode: 'full', repairGeneration: 501 },
        });
        expect(runtime.ledger.claimNextWorkOrder()).toBeNull();
      } finally {
        runtime.db.close();
      }
    }
  );

  it('TG-06 non-force scheduled repair accepts exact contract_no_update', async () => {
    const runtime = await registerOwnerFullRuntime('no-update');
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtime.ledger.countPendingWorkOrders()).toBe(1);

      await runtime.consumer.tick();

      expect(runtime.boardRefreshGate.needsFullRepair()).toBe(false);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(runtime.ledger.claimNextWorkOrder()).toBeNull();
    } finally {
      runtime.db.close();
    }
  });

  it('TG-01/TG-06 successful full then a new delta enqueues full repair on the next timer', async () => {
    const runtime = await registerOwnerFullRuntime('report');
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await runtime.consumer.tick();
      expect(runtime.boardRefreshGate.needsFullRepair()).toBe(false);

      runtime.eventBus.emit({
        type: 'operator:channel-delta',
        channelKey: 'telegram:owner',
        lines: ['newer delta after verified full'],
        eventIds: ['evt-newer-after-full'],
      });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(runtime.ledger.claimNextWorkOrder()).toMatchObject({
        idempotencyKey: expect.stringContaining('board:reconcile:telegram:owner:'),
        payload: { mode: 'reconcile', repairGeneration: 501 },
      });
      expect(runtime.ledger.claimNextWorkOrder()).toMatchObject({
        idempotencyKey: 'board:full:repair',
        payload: { mode: 'full', repairGeneration: 501 },
      });
    } finally {
      runtime.db.close();
    }
  });

  it('TG-06 forced agent refresh enqueue failure leaves dirt for scheduled repair', async () => {
    const runtime = await registerOwnerFullRuntime('report');
    try {
      runtime.boardRefreshGate.completeVerifiedFull(500);
      vi.spyOn(runtime.ledger, 'enqueueWorkOrder').mockImplementationOnce(() => {
        throw new Error('synthetic enqueue failure');
      });

      await request(runtime.apiServer.app).post('/api/report/agent-refresh').expect(200);

      expect(runtime.boardRefreshGate.needsFullRepair()).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtime.ledger.claimNextWorkOrder()).toMatchObject({
        idempotencyKey: 'board:full:repair',
        payload: { mode: 'full', repairGeneration: 501 },
      });
    } finally {
      runtime.db.close();
    }
  });

  it('TG-06 forced agent refresh keeps the disabled legacy payload', async () => {
    const db = new Database(':memory:');
    process.env.MAMA_BOARD_RECONCILE = '0';
    try {
      createConnectorEventTable(db);
      const { apiServer, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await request(apiServer.app).post('/api/report/agent-refresh').expect(200);

      expect(ledger.claimNextWorkOrder()?.payload).toEqual({
        attempts: 1,
        mode: 'full',
        force: true,
      });
    } finally {
      process.env.MAMA_BOARD_RECONCILE = '1';
      db.close();
    }
  });

  it('TG-06 stop owns boot/interval/reconcile timers and removes the delta listener across restart', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      const eventBus = new AgentEventBus();
      const oldGate = new BoardRefreshGate({ initialGeneration: 700 });
      const first = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
        boardRefreshGate: oldGate,
        eventBus,
      });
      first.routeHandle.stop();

      eventBus.emit({
        type: 'operator:channel-delta',
        channelKey: 'telegram:owner',
        lines: ['after stop'],
        eventIds: ['evt-after-stop'],
      });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 10_000);
      expect(first.ledger.claimNextWorkOrder()).toBeNull();
      expect(oldGate.dirtyGeneration('telegram:owner')).toBeNull();

      const newGate = new BoardRefreshGate({ initialGeneration: 800 });
      const restarted = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
        ledger: first.ledger,
        boardRefreshGate: newGate,
        eventBus,
      });
      eventBus.emit({
        type: 'operator:channel-delta',
        channelKey: 'telegram:owner',
        lines: ['after restart'],
        eventIds: ['evt-after-restart'],
      });

      expect(oldGate.dirtyGeneration('telegram:owner')).toBeNull();
      expect(newGate.dirtyGeneration('telegram:owner')).toBe(801);
      restarted.routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('consumes an enabled private partition when the immutable raw scope does not authorize it', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      insertKagemushaEvent(db, { eventId: 'evt_out_of_scope' });
      const { eventBus, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
        rawConnectorScope: [],
      });

      await emitReconcileDelta(eventBus, 'evt_out_of_scope');

      expect(ledger.claimNextWorkOrder()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('fails closed for a malformed boot connector snapshot without a private prompt', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      insertKagemushaEvent(db, { eventId: 'evt_malformed_boot' });
      const { eventBus, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: malformedConnectorConfig,
      });

      await emitReconcileDelta(eventBus, 'evt_malformed_boot');

      expect(ledger.claimNextWorkOrder()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('emits a later lifecycle candidate from an existing binding without task hints', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new TaskLedger(db);
      const { taskId } = bindExistingTask(ledger);
      createConnectorEventTable(db);
      insertKagemushaEvent(db, {
        eventId: 'evt_later',
        channel: 'room-later',
        observationSeq: 10,
      });
      const { eventBus } = await registerReconcileRuntime({
        db,
        ledger,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await emitReconcileDelta(eventBus, 'evt_later', 'kagemusha:room-later');

      const candidates = lifecycleCandidates(ledger.claimNextWorkOrder());
      expect(candidates.bindingCandidates).toEqual([]);
      expect(candidates.lifecycleCandidates).toMatchObject([
        { eventId: 'evt_later', taskId, proposedStatus: 'done' },
      ]);
    } finally {
      db.close();
    }
  });

  it('TG-06 accepts production Kagemusha metadata and applies the receipted native transition', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new TaskLedger(db);
      const { taskId } = bindExistingTask(ledger);
      createConnectorEventTable(db);
      insertKagemushaEvent(db, {
        eventId: 'evt_production_metadata',
        channel: 'room-production',
        observationSeq: 10,
        metadata: {
          taskId: 42,
          status: 'done',
          priority: 'high',
          deadline: 1_775_260_800_000,
          sourceRoom: 'room-production',
          rawConnector: 'kagemusha',
          autoCreated: true,
        },
      });
      const { eventBus } = await registerReconcileRuntime({
        db,
        ledger,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await emitReconcileDelta(eventBus, 'evt_production_metadata', 'kagemusha:room-production');

      const workorder = ledger.claimNextWorkOrder();
      const candidate = lifecycleCandidates(workorder).lifecycleCandidates[0];
      if (!workorder || !candidate) throw new Error('production lifecycle candidate expected');
      expect(candidate).toMatchObject({
        eventId: 'evt_production_metadata',
        taskId,
        proposedStatus: 'done',
      });

      const receipt = ledger.applyExternalLifecycleDecision(
        workorder.id,
        {
          candidate_id: candidate.candidateId,
          decision: 'apply',
          reason: 'TG-06 production Kagemusha lifecycle confirmed',
          expected_revision: candidate.taskRevision,
        },
        {
          runId: 'test_production_metadata',
          workOrderAttemptId: workorder.id,
          causeEventIds: ['evt_production_metadata'],
        }
      );

      expect(receipt).toMatchObject({
        candidateId: candidate.candidateId,
        outcome: 'applied',
        taskId,
      });
      expect(ledger.getExternalCandidateReceipt(candidate.candidateId)).toEqual(receipt);
      expect(ledger.getById(taskId)).toMatchObject({
        status: 'done',
        revision: candidate.taskRevision + 1,
        latestEvent: candidate.evidenceSummary,
      });
    } finally {
      db.close();
    }
  });

  it('suppresses a candidate after its exact lifecycle receipt exists', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new TaskLedger(db);
      bindExistingTask(ledger);
      createConnectorEventTable(db);
      insertKagemushaEvent(db, { eventId: 'evt_receipted', observationSeq: 10 });
      const { eventBus } = await registerReconcileRuntime({
        db,
        ledger,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await emitReconcileDelta(eventBus, 'evt_receipted');
      const first = ledger.claimNextWorkOrder();
      const firstCandidate = lifecycleCandidates(first).lifecycleCandidates[0];
      if (!first || !firstCandidate) throw new Error('lifecycle candidate expected');
      ledger.applyExternalLifecycleDecision(
        first.id,
        {
          candidate_id: firstCandidate.candidateId,
          decision: 'retain',
          reason: 'reviewed exact lifecycle evidence',
          expected_revision: firstCandidate.taskRevision,
        },
        { runId: 'test_receipt', workOrderAttemptId: first.id, causeEventIds: ['evt_receipted'] }
      );

      await emitReconcileDelta(eventBus, 'evt_receipted');

      const second = lifecycleCandidates(ledger.claimNextWorkOrder());
      expect(second.lifecycleCandidates).toEqual([]);
      expect(second.bindingCandidates).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('enqueues a bounded diagnostic for an enabled malformed lifecycle event', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      insertKagemushaEvent(db, { eventId: 'evt_malformed', status: 'not-a-lifecycle' });
      const { eventBus, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await emitReconcileDelta(eventBus, 'evt_malformed');

      expect(lifecycleCandidates(ledger.claimNextWorkOrder())).toEqual({
        bindingCandidates: [],
        lifecycleCandidates: [],
        diagnostics: [{ eventId: 'evt_malformed', code: 'unknown_status' }],
      });
    } finally {
      db.close();
    }
  });

  it('restores an unconsumed batch after an adapter read failure and retries it', async () => {
    const db = new Database(':memory:');
    try {
      createConnectorEventTable(db);
      insertKagemushaEvent(db, { eventId: 'evt_retry' });
      let failReads = true;
      const { eventBus, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
        getAdapter: () => {
          if (failReads) {
            return {
              prepare: () => {
                throw new Error('connector event index unavailable');
              },
            };
          }
          return db;
        },
      });

      await emitReconcileDelta(eventBus, 'evt_retry');
      expect(ledger.claimNextWorkOrder()).toBeNull();
      failReads = false;
      await vi.advanceTimersByTimeAsync(60_000);

      // The dashboard's normal startup workorder fires before the one-minute
      // scheduler retry; it is unrelated and does not consume the retry batch.
      expect(ledger.claimNextWorkOrder()?.payload.mode).toBe('full');
      expect(lifecycleCandidates(ledger.claimNextWorkOrder())).toMatchObject({
        bindingCandidates: [],
        lifecycleCandidates: [],
        diagnostics: [{ eventId: 'evt_retry', code: 'ambiguous_task_pair' }],
      });
    } finally {
      db.close();
    }
  });
});
