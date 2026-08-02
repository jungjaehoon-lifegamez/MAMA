import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayToolExecutor } from '../../../src/agent/gateway-tool-executor.js';
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
    content_hash TEXT,
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
    'a'.repeat(64),
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
  rawConnectorScope?: readonly string[];
  getAdapter?: () => { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } };
}): Promise<{ eventBus: AgentEventBus; ledger: TaskLedger }> {
  const policy = resolvePrivateConnectorPolicy(input.connectorConfigLoadResult);
  const eventBus = new AgentEventBus();
  const toolExecutor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    privateConnectorPolicy: policy,
  });
  const ledger = input.ledger ?? new TaskLedger(input.db);
  toolExecutor.setTaskLedger(ledger);
  const apiServer = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: input.connectorConfigLoadResult,
    privateConnectorPolicy: policy,
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
    rawConnectorScope: input.rawConnectorScope ?? input.connectorConfigLoadResult.enabledNames,
    getAdapter: input.getAdapter ?? (() => input.db),
  });

  return { eventBus, ledger };
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
