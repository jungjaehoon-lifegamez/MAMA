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
import { TaskLedger } from '../../../src/operator/task-ledger.js';
import { BoardRefreshGate } from '../../../src/operator/board-refresh-gate.js';
import {
  NO_DURABLE_RESULT_REASON,
  REQUIRED_BOARD_JUDGMENT_SLOTS,
  REQUIRED_FULL_BOARD_SLOTS,
} from '../../../src/operator/workorder-hooks.js';
import type { ReportStore } from '../../../src/api/report-handler.js';
import { WorkOrderConsumer } from '../../../src/operator/workorder-consumer.js';
import { CronScheduler } from '../../../src/scheduler/cron-scheduler.js';
import Database from '../../../src/sqlite.js';
import type { OAuthManager } from '../../../src/auth/index.js';

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

function createConfig(dashboardEnabled = true): MAMAConfig {
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
          enabled: dashboardEnabled,
        },
      },
    },
  };
}

function createBoardInputTables(db: Database): void {
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
  // The other board input the delta gate reads from the mama-core adapter.
  db.exec(`CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    topic TEXT,
    created_at TEXT
  )`);
}

/**
 * Simulate a run publishing the judgment slots while the HOST owns the pipeline projection -
 * the daemon's own wiring, and the only shape in which the board has a basis revision.
 */
function publishBoardWithProjection(
  apiServer: { reportStore: ReportStore },
  basisRevision = 'gen-7'
): void {
  apiServer.reportStore.setTaskProjectionProvider(() => ({
    basisRevision,
    html: `<p>pipeline ${basisRevision}</p>`,
  }));
  for (const [index, slotId] of REQUIRED_BOARD_JUDGMENT_SLOTS.entries()) {
    apiServer.reportStore.update(slotId, `<p>${slotId}</p>`, index);
  }
  apiServer.reportStore.refreshTaskProjection();
}

/** Simulate a full run publishing the four required board slots. */
function publishBoardSlots(apiServer: { reportStore: ReportStore }): void {
  for (const [index, slotId] of REQUIRED_FULL_BOARD_SLOTS.entries()) {
    apiServer.reportStore.update(slotId, `<p>${slotId}</p>`, index);
  }
}

async function registerReconcileRuntime(input: {
  db: Database;
  connectorConfigLoadResult: ConnectorConfigLoadResult;
  config?: MAMAConfig;
  ledger?: TaskLedger;
  boardRefreshGate?: BoardRefreshGate | null;
  eventBus?: AgentEventBus;
  rawConnectorScope?: readonly string[];
  getAdapter?: () => { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } };
  requestFullReport?: () => { accepted: boolean; reason?: 'busy' | 'unavailable' };
}): Promise<{
  apiServer: ReturnType<typeof createApiServer>;
  boardRefreshGate: BoardRefreshGate | null;
  eventBus: AgentEventBus;
  ledger: TaskLedger;
  routeHandle: {
    readonly boardReconcileEnabled: boolean;
    requestBoardRepair: () => void;
    stop: () => void;
  };
}> {
  const policy = resolvePrivateConnectorPolicy(input.connectorConfigLoadResult);
  const eventBus = input.eventBus ?? new AgentEventBus();
  const toolExecutor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    privateConnectorPolicy: policy,
  });
  const ledger = input.ledger ?? new TaskLedger(input.db);
  const boardRefreshGate =
    input.boardRefreshGate !== undefined ? input.boardRefreshGate : new BoardRefreshGate();
  toolExecutor.setTaskLedger(ledger);
  const apiServer = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: input.connectorConfigLoadResult,
    privateConnectorPolicy: policy,
  });

  const routeHandle = await registerApiRoutes({
    config: input.config ?? createConfig(),
    apiServer,
    eventBus,
    oauthManager: {} as OAuthManager,
    mamaApi: {} as MAMAApiShape,
    messageRouter: {} as MessageRouter,
    runOwnerStimulus: vi.fn(async () => ({
      response: 'owner response',
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    })),
    toolExecutor,
    discordGateway: null,
    slackGateway: null,
    graphHandler: async () => false,
    privateConnectorPolicy: policy,
    rawConnectorScope: input.rawConnectorScope ?? input.connectorConfigLoadResult.enabledNames,
    boardRefreshGate,
    getAdapter: input.getAdapter ?? (() => input.db),
    requestFullReport: input.requestFullReport,
  });

  return { apiServer, boardRefreshGate, eventBus, ledger, routeHandle };
}

it('accepts one authenticated on-demand owner report through the existing trigger-loop seam', async () => {
  const db = new Database(':memory:');
  initAgentTables(db);
  createBoardInputTables(db);
  const requestFullReport = vi.fn(() => ({ accepted: true }));
  const runtime = await registerReconcileRuntime({
    db,
    connectorConfigLoadResult: enabledConnectorConfig,
    requestFullReport,
  });

  try {
    const response = await request(runtime.apiServer.app).post('/api/operator/report');
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ ok: true, status: 'accepted' });
    expect(requestFullReport).toHaveBeenCalledOnce();
  } finally {
    runtime.routeHandle.stop();
    db.close();
  }
});

it.each(['/api/discord/cron', '/api/report'])(
  'returns 410 for the unreceipted legacy model-and-send route %s',
  async (route) => {
    const db = new Database(':memory:');
    initAgentTables(db);
    createBoardInputTables(db);
    const runtime = await registerReconcileRuntime({
      db,
      connectorConfigLoadResult: enabledConnectorConfig,
    });

    try {
      const response = await request(runtime.apiServer.app).post(route).send({
        channelId: 'synthetic-channel',
        prompt: 'synthetic prompt',
      });
      expect(response.status).toBe(410);
      expect(response.body.error).toMatch(/retired/i);
    } finally {
      runtime.routeHandle.stop();
      db.close();
    }
  }
);

it('TG-05 removes direct and proxied viewer sessions from the real Express runtime', async () => {
  const db = new Database(':memory:');
  initAgentTables(db);
  createBoardInputTables(db);
  const runtime = await registerReconcileRuntime({
    db,
    connectorConfigLoadResult: enabledConnectorConfig,
  });

  try {
    for (const route of ['/api/sessions', '/api/sessions/last-active', '/api/session/create']) {
      expect((await request(runtime.apiServer.app).get(route)).status, route).toBe(404);
    }
    expect((await request(runtime.apiServer.app).get('/api/report')).status).toBe(200);
    expect((await request(runtime.apiServer.app).get('/health')).status).toBe(200);
  } finally {
    runtime.routeHandle.stop();
    db.close();
  }
});

it.each([
  { reason: 'busy' as const, status: 409 },
  { reason: 'unavailable' as const, status: 503 },
])('reports $reason admission as HTTP $status', async ({ reason, status }) => {
  const db = new Database(':memory:');
  initAgentTables(db);
  createBoardInputTables(db);
  const runtime = await registerReconcileRuntime({
    db,
    connectorConfigLoadResult: enabledConnectorConfig,
    requestFullReport: () => ({ accepted: false, reason }),
  });

  try {
    const response = await request(runtime.apiServer.app).post('/api/operator/report');
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ ok: false, reason });
  } finally {
    runtime.routeHandle.stop();
    db.close();
  }
});

async function registerOwnerFullRuntime(
  effect: 'report' | 'no-update' | 'failed' | 'none',
  options: { observeSubagentStart?: boolean } = {}
) {
  const db = new Database(':memory:');
  initAgentTables(db);
  createBoardInputTables(db);
  const policy = resolvePrivateConnectorPolicy(enabledConnectorConfig);
  const eventBus = new AgentEventBus();
  const toolExecutor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    privateConnectorPolicy: policy,
  });
  const ledger = new TaskLedger(db);
  const boardRefreshGate = new BoardRefreshGate({ initialGeneration: 500 });
  const duringRun: { current: (() => void) | null } = { current: null };
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
      // Codex-shaped: this harness exercises the delegated attempt path.
      supportsNativeSubagents: true,
      runWithContent: async (_content, options_) => {
        const runOptions = options_ as { workorderAttemptId?: number };
        const context = {
          executionSurface: 'model_tool' as const,
          source: 'operator' as const,
          channelId: 'worker:board',
          workorderAttemptId: runOptions.workorderAttemptId,
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
        if (options.observeSubagentStart) {
          (
            options_ as {
              streamCallbacks?: {
                onToolUse?: (name: string, input: Record<string, unknown>) => void;
              };
            }
          ).streamCallbacks?.onToolUse?.('collabAgentToolCall', {});
        }
        duringRun.current?.();
        return { response: effect === 'none' ? 'DONE in prose only' : 'DONE' };
      },
    },
    loadOwnerBrief: () => 'Synthetic board worker brief',
    runOptionsFor: (workOrder) => ({ workorderAttemptId: workOrder.id }),
    noticeOwner: () => undefined,
    opsAlarm: { configured: false, send: async () => undefined },
  });

  const routeHandle = await registerApiRoutes({
    config: createConfig(),
    apiServer,
    eventBus,
    oauthManager: {} as OAuthManager,
    mamaApi: {} as MAMAApiShape,
    messageRouter: {} as MessageRouter,
    runOwnerStimulus: vi.fn(async () => ({
      response: 'owner response',
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    })),
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
  return {
    apiServer,
    boardRefreshGate,
    consumer,
    db,
    eventBus,
    ledger,
    duringRun,
    routeHandle,
  };
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

  it('TG-06 enqueues one boot repair with an exact scope and dedupes it while open', async () => {
    const db = new Database(':memory:');
    try {
      createBoardInputTables(db);
      const { ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      const legacy = ledger.create({ title: 'legacy task' });
      ledger.create({ title: 'qualified task', completion_criteria: 'artifact delivered' });

      await vi.advanceTimersByTimeAsync(10_000);
      const bootRepair = ledger.claimNextWorkOrder();
      expect(bootRepair).toMatchObject({
        workKind: 'board',
        idempotencyKey: 'board:full:repair',
        payload: {
          mode: 'full',
          repairGeneration: expect.any(Number),
          noUpdateScope: expect.stringMatching(/^full:\d+$/),
          reclassificationCandidates: [{ taskId: legacy.id, taskRevision: legacy.revision }],
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

  it('TG-04 keeps the Stage-2 Board runtime independent of disabled legacy persona config', async () => {
    const db = new Database(':memory:');
    try {
      createBoardInputTables(db);
      const { ledger, routeHandle } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
        config: createConfig(false),
      });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(ledger.claimNextWorkOrder()).toMatchObject({
        workKind: 'board',
        idempotencyKey: 'board:full:repair',
        payload: { mode: 'full', repairGeneration: expect.any(Number) },
      });
      expect(routeHandle.boardReconcileEnabled).toBe(true);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  /**
   * Owner decision 2026-09-09. The gate used to start dirty ("buys one full run per boot")
   * and the watermark carried an in-memory notice term that reset with the process, so every
   * restart bought a full board run and the owner's first message after a restart waited on
   * it. A restart is not evidence.
   */
  it('a restart enqueues nothing when the board is already current', async () => {
    const db = new Database(':memory:');
    try {
      createBoardInputTables(db);
      const ledger = new TaskLedger(db);
      const first = await registerReconcileRuntime({
        db,
        ledger,
        boardRefreshGate: new BoardRefreshGate(),
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const initial = ledger.claimNextWorkOrder();
      if (!initial) throw new Error('first full expected (no baseline yet)');
      publishBoardSlots(first.apiServer);
      ledger.completeWorkOrder(initial.id);
      first.routeHandle.stop();

      // Restart: the durable ledger survives, the in-memory gate does not.
      const second = await registerReconcileRuntime({
        db,
        ledger,
        boardRefreshGate: new BoardRefreshGate(),
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      publishBoardSlots(second.apiServer);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ledger.claimNextWorkOrder()).toBeNull();

      // And the schedule stays quiet until something the board reads actually moves.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(ledger.claimNextWorkOrder()).toBeNull();
      second.routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('Fix E delta-gates the 30-minute full schedule when reconcile is disabled', async () => {
    const db = new Database(':memory:');
    const previousTestReconcile = process.env.MAMA_BOARD_RECONCILE;
    process.env.MAMA_BOARD_RECONCILE = '0';
    try {
      createBoardInputTables(db);
      const { apiServer, ledger, routeHandle } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const boot = ledger.claimNextWorkOrder();
      // No completed predecessor exists, so this first run happens on that evidence,
      // and it carries the watermark that becomes the next tick's baseline.
      expect(boot?.payload.mode).toBe('full');
      expect(boot?.payload.deltaWatermark).toEqual(expect.any(String));
      if (!boot) throw new Error('boot full expected');
      publishBoardSlots(apiServer);
      ledger.completeWorkOrder(boot.id);

      // Nothing the board reads has moved since that published run.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(ledger.claimNextWorkOrder()).toBeNull();

      // One new connector observation re-opens the schedule.
      db.prepare(
        `INSERT INTO connector_event_index
           (event_index_id, source_connector, channel, operator_observation_seq)
         VALUES ('e1', 'alpha', 'room', 1)`
      ).run();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      const afterConnector = ledger.claimNextWorkOrder();
      expect(afterConnector?.payload.mode).toBe('full');
      expect(afterConnector?.payload.deltaWatermark).not.toBe(boot.payload.deltaWatermark);
      routeHandle.stop();
    } finally {
      if (previousTestReconcile === undefined) delete process.env.MAMA_BOARD_RECONCILE;
      else process.env.MAMA_BOARD_RECONCILE = previousTestReconcile;
      db.close();
    }
  });

  /**
   * Owner decision 2026-09-09: with a published board behind it, the scheduled run UPDATES that
   * board from the accumulated state instead of rebuilding it from the raw sources.
   */
  it('enqueues mode delta anchored on the published board once a baseline exists', async () => {
    const db = new Database(':memory:');
    const previousTestReconcile = process.env.MAMA_BOARD_RECONCILE;
    process.env.MAMA_BOARD_RECONCILE = '0';
    try {
      createBoardInputTables(db);
      const { apiServer, ledger, routeHandle } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const boot = ledger.claimNextWorkOrder();
      if (!boot) throw new Error('boot full expected');
      // No baseline existed, so the first run rebuilds.
      expect(boot.payload.mode).toBe('full');
      publishBoardWithProjection(apiServer);
      ledger.completeWorkOrder(boot.id);

      db.prepare(
        `INSERT INTO connector_event_index
           (event_index_id, source_connector, channel, operator_observation_seq)
         VALUES ('e1', 'alpha', 'room', 1)`
      ).run();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      const first = ledger.claimNextWorkOrder();
      if (!first) throw new Error('delta expected');
      expect(first.payload.mode).toBe('delta');
      expect(first.payload.deltaBasisRevision).toBe('gen-7');
      expect(first.payload.deltaAnchor).toBe(
        new Date(first.payload.deltaAnchor as string).toISOString()
      );
      // The anchor names the published board, never a later instant.
      expect(Date.parse(first.payload.deltaAnchor as string)).toBeLessThanOrEqual(Date.now());

      // A verified delta becomes the next baseline: nothing new arrived, so nothing re-fires.
      // The projection moves with it, the way the host's pipeline slot does once the ledger has.
      publishBoardWithProjection(apiServer, 'gen-8');
      ledger.completeWorkOrder(first.id);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(ledger.claimNextWorkOrder()).toBeNull();

      // And the next arrival is another delta, not a rebuild.
      db.prepare(
        `INSERT INTO connector_event_index
           (event_index_id, source_connector, channel, operator_observation_seq)
         VALUES ('e2', 'alpha', 'room', 2)`
      ).run();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(ledger.claimNextWorkOrder()?.payload.mode).toBe('delta');
      routeHandle.stop();
    } finally {
      if (previousTestReconcile === undefined) delete process.env.MAMA_BOARD_RECONCILE;
      else process.env.MAMA_BOARD_RECONCILE = previousTestReconcile;
      db.close();
    }
  });

  it('keeps an owner-forced refresh a full rebuild', async () => {
    const db = new Database(':memory:');
    const previousTestReconcile = process.env.MAMA_BOARD_RECONCILE;
    process.env.MAMA_BOARD_RECONCILE = '0';
    try {
      createBoardInputTables(db);
      const { apiServer, ledger, routeHandle } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const boot = ledger.claimNextWorkOrder();
      if (!boot) throw new Error('boot full expected');
      publishBoardWithProjection(apiServer);
      ledger.completeWorkOrder(boot.id);

      await request(apiServer.app).post('/api/report/agent-refresh').expect(200);
      const forced = ledger.claimNextWorkOrder();
      expect(forced?.payload.mode).toBe('full');
      expect(forced?.payload.deltaAnchor).toBeUndefined();
      routeHandle.stop();
    } finally {
      if (previousTestReconcile === undefined) delete process.env.MAMA_BOARD_RECONCILE;
      else process.env.MAMA_BOARD_RECONCILE = previousTestReconcile;
      db.close();
    }
  });

  it('Fix E delta-gates a dirty repair gate too (MAMA_BOARD_RECONCILE=1)', async () => {
    const runtime = await registerOwnerFullRuntime('none');
    try {
      // No baseline yet, so the first tick runs on evidence about the board itself -
      // not on boot dirt, which the gate no longer invents (owner decision 2026-09-09).
      await vi.advanceTimersByTimeAsync(10_000);
      const boot = runtime.ledger.claimNextWorkOrder();
      expect(boot?.payload.mode).toBe('full');
      expect(boot?.payload.deltaWatermark).toEqual(expect.any(String));
      if (!boot) throw new Error('boot full expected');
      publishBoardSlots(runtime.apiServer);
      runtime.ledger.completeWorkOrder(boot.id);

      // A channel delta arrives, so the repair gate is dirty - but nothing the board
      // reads has moved, so the duplicate full run is still skipped.
      runtime.boardRefreshGate.markChannelDirty('slack:C1');
      expect(runtime.boardRefreshGate.needsFullRepair()).toBe(true);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(runtime.ledger.claimNextWorkOrder()).toBeNull();

      // A native owner task is a board input that never touches any connector.
      runtime.ledger.create({ title: 'off-connector item' });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(runtime.ledger.claimNextWorkOrder()?.payload.mode).toBe('full');
    } finally {
      runtime.routeHandle.stop();
      runtime.db.close();
    }
  });

  it('Fix E never skips a run that left no published board behind while input is dirty', async () => {
    const runtime = await registerOwnerFullRuntime('none');
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      const boot = runtime.ledger.claimNextWorkOrder();
      if (!boot) throw new Error('first full expected');
      // Completed without publishing: not evidence of a rebuilt board.
      runtime.ledger.completeWorkOrder(boot.id);

      // With a clean gate this is an honestly empty board and re-running it every 30
      // minutes forever would be the boot-forcing bug in another shape.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(runtime.ledger.claimNextWorkOrder()).toBeNull();

      // Input arrived and there is still no published board: that must not be skipped.
      runtime.boardRefreshGate.markChannelDirty('slack:C1');
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(runtime.ledger.claimNextWorkOrder()?.payload.mode).toBe('full');
    } finally {
      runtime.routeHandle.stop();
      runtime.db.close();
    }
  });

  it('Fix E re-opens the schedule once the staleness bound passes', async () => {
    const runtime = await registerOwnerFullRuntime('none');
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      const boot = runtime.ledger.claimNextWorkOrder();
      if (!boot) throw new Error('boot full expected');
      publishBoardSlots(runtime.apiServer);
      runtime.ledger.completeWorkOrder(boot.id);

      // Quiet ticks inside the 2h bound stay skipped...
      for (let tick = 0; tick < 4; tick += 1) {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(runtime.ledger.claimNextWorkOrder()).toBeNull();
      }
      // ...and the first tick past it runs anyway, whatever the signals say.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(runtime.ledger.claimNextWorkOrder()?.payload.mode).toBe('full');
    } finally {
      runtime.routeHandle.stop();
      runtime.db.close();
    }
  });

  it('TG-06 safely generation-binds an eventless manual reconcile', async () => {
    const db = new Database(':memory:');
    try {
      createBoardInputTables(db);
      const { apiServer, ledger } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      const channelTask = ledger.create({
        title: 'existing channel task',
        source_channel: 'telegram:owner',
      });
      ledger.create({ title: 'other channel task', source_channel: 'telegram:other' });

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
        reclassificationCandidates: [
          { taskId: channelTask.id, taskRevision: channelTask.revision },
        ],
      });
    } finally {
      db.close();
    }
  });

  it('TG-06 rejects an oversized manual reconcile channel before marking gate dirt', async () => {
    const db = new Database(':memory:');
    try {
      createBoardInputTables(db);
      const { apiServer, boardRefreshGate, routeHandle } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });
      const channelKey = 'x'.repeat(1001);

      const response = await request(apiServer.app)
        .post('/api/operator/reconcile')
        .send({ channelKey, lines: ['delta'] });

      expect(response.status).toBe(400);
      expect(boardRefreshGate?.dirtyGeneration(channelKey)).toBeNull();
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

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
      runtime.routeHandle.stop();
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
        runtime.routeHandle.stop();
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
        runtime.routeHandle.stop();
        runtime.db.close();
      }
    }
  );

  it('fails a board full attempt whose run produced no durable result', async () => {
    // board#4760 live: 29s, zero gateway calls, 23 characters of prose, then 'completed'.
    const runtime = await registerOwnerFullRuntime('none');
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtime.ledger.countPendingWorkOrders()).toBe(1);

      await runtime.consumer.tick();

      const rows = runtime.db
        .prepare(
          `SELECT status, latest_event FROM operator_tasks WHERE kind = 'system' ORDER BY id ASC`
        )
        .all() as Array<{ status: string; latest_event: string | null }>;
      expect(rows).toEqual([{ status: 'failed', latest_event: NO_DURABLE_RESULT_REASON }]);
    } finally {
      runtime.routeHandle.stop();
      runtime.db.close();
    }
  });

  it('keeps a board full attempt open as delegated when the run started a native subagent', async () => {
    const runtime = await registerOwnerFullRuntime('none', { observeSubagentStart: true });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtime.ledger.countPendingWorkOrders()).toBe(1);

      await runtime.consumer.tick();

      const rows = runtime.db
        .prepare(`SELECT id, status FROM operator_tasks WHERE kind = 'system' ORDER BY id ASC`)
        .all() as Array<{ id: number; status: string }>;
      expect(rows.map((row) => row.status)).toEqual(['in_progress']);
    } finally {
      runtime.routeHandle.stop();
      runtime.db.close();
    }
  });

  it('TG-06 non-force scheduled repair accepts exact contract_no_update', async () => {
    const runtime = await registerOwnerFullRuntime('no-update');
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtime.ledger.countPendingWorkOrders()).toBe(1);

      await runtime.consumer.tick();

      // The exact-scope receipt is the durable result, so the attempt is done, not failed.
      expect(
        runtime.db
          .prepare(`SELECT status FROM operator_tasks WHERE kind = 'system' ORDER BY id ASC`)
          .all()
      ).toEqual([{ status: 'done' }]);
      expect(runtime.boardRefreshGate.needsFullRepair()).toBe(false);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(runtime.ledger.claimNextWorkOrder()).toBeNull();
    } finally {
      runtime.routeHandle.stop();
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
      runtime.routeHandle.stop();
      runtime.db.close();
    }
  });

  it('TG-06 flag off keeps the host gate on for forced full refreshes', async () => {
    const db = new Database(':memory:');
    const previousTestReconcile = process.env.MAMA_BOARD_RECONCILE;
    process.env.MAMA_BOARD_RECONCILE = '0';
    try {
      createBoardInputTables(db);
      const { apiServer, ledger, routeHandle } = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
      });

      await request(apiServer.app).post('/api/report/agent-refresh').expect(200);

      expect(ledger.claimNextWorkOrder()?.payload).toEqual({
        attempts: 1,
        mode: 'full',
        force: true,
        repairGeneration: expect.any(Number),
        noUpdateScope: expect.stringMatching(/^full:\d+$/),
        reclassificationCandidates: [],
        // A forced full run is still a real rebuild, so it records a baseline.
        deltaWatermark: expect.any(String),
      });
      expect(routeHandle.boardReconcileEnabled).toBe(false);
      routeHandle.stop();
    } finally {
      if (previousTestReconcile === undefined) delete process.env.MAMA_BOARD_RECONCILE;
      else process.env.MAMA_BOARD_RECONCILE = previousTestReconcile;
      db.close();
    }
  });

  it('TG-06 stop owns boot, interval, and manual reconcile timers across restart', async () => {
    const db = new Database(':memory:');
    try {
      createBoardInputTables(db);
      const oldGate = new BoardRefreshGate({ initialGeneration: 700 });
      const first = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
        boardRefreshGate: oldGate,
      });
      first.routeHandle.stop();

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 10_000);
      expect(first.ledger.claimNextWorkOrder()).toBeNull();

      const newGate = new BoardRefreshGate({ initialGeneration: 800 });
      const restarted = await registerReconcileRuntime({
        db,
        connectorConfigLoadResult: enabledConnectorConfig,
        ledger: first.ledger,
        boardRefreshGate: newGate,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(restarted.ledger.claimNextWorkOrder()?.payload).toMatchObject({
        mode: 'full',
        repairGeneration: 800,
      });
      restarted.routeHandle.stop();
    } finally {
      db.close();
    }
  });
});
