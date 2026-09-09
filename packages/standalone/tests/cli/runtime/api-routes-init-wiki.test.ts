/**
 * Wiki daily-continuity runtime wiring: boot / hourly / event / manual triggers
 * enqueue the TYPED continuity payload, the same-owner-date+watermark gate skips
 * a quiet tick, a malformed manual owner date is rejected, and stop() clears the
 * wiki boot and continuity timers. Fake time + in-memory/temp stores only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { GatewayToolExecutor } from '../../../src/agent/gateway-tool-executor.js';
import { createApiServer } from '../../../src/api/index.js';
import { DEFAULT_CONFIG, type MAMAConfig } from '../../../src/cli/config/types.js';
import { registerApiRoutes } from '../../../src/cli/runtime/api-routes-init.js';
import type { MAMAApiShape } from '../../../src/cli/runtime/types.js';
import type { ConnectorConfigLoadResult } from '../../../src/connectors/config-loader.js';
import { resolvePrivateConnectorPolicy } from '../../../src/connectors/private-connector-policy.js';
import type { MessageRouter } from '../../../src/gateways/index.js';
import { AgentEventBus } from '../../../src/multi-agent/agent-event-bus.js';
import { TaskLedger } from '../../../src/operator/task-ledger.js';
import { CronScheduler } from '../../../src/scheduler/cron-scheduler.js';
import Database from '../../../src/sqlite.js';
import type { OAuthManager } from '../../../src/auth/index.js';

const emptyConnectorConfig: ConnectorConfigLoadResult = {
  ok: true,
  config: {},
  enabledNames: [],
};

const RAW_CONNECTOR_SCOPE = ['slack', 'chatwork'];

function createWikiConfig(vaultPath: string): MAMAConfig {
  const config = {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent },
    database: { ...DEFAULT_CONFIG.database },
    logging: { ...DEFAULT_CONFIG.logging },
    multi_agent: {
      enabled: true,
      loop_prevention: { max_chain_length: 3, global_cooldown_ms: 60, chain_window_ms: 60 },
      agents: {
        'wiki-agent': {
          name: 'Wiki',
          display_name: 'Wiki',
          trigger_prefix: '@wiki',
          persona_file: 'wiki.md',
          enabled: true,
        },
      },
    },
  } as MAMAConfig;
  // config.wiki is read via a cast in production; attach it the same way.
  (config as MAMAConfig & { wiki: unknown }).wiki = {
    enabled: true,
    vaultPath,
    wikiDir: 'wiki',
  };
  return config;
}

function createSourceTables(db: Database): void {
  db.exec(`CREATE TABLE connector_event_index (
    event_index_id TEXT PRIMARY KEY,
    source_connector TEXT,
    channel TEXT,
    operator_observation_seq INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    topic TEXT,
    created_at TEXT
  )`);
}

/** Move the connector observation term so the source watermark changes. */
function bumpConnectorWatermark(db: Database, seq: number): void {
  db.prepare(
    `INSERT INTO connector_event_index (event_index_id, source_connector, channel, operator_observation_seq)
     VALUES (?, 'slack', 'room', ?)`
  ).run(`evt-${seq}`, seq);
}

interface WikiRow {
  id: number;
  payload: Record<string, unknown>;
}

function wikiRows(db: Database): WikiRow[] {
  return (
    db
      .prepare(
        `SELECT id, payload FROM operator_tasks
          WHERE kind = 'system' AND source_channel = 'workorder:wiki'
          ORDER BY id ASC`
      )
      .all() as Array<{ id: number; payload: string }>
  ).map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

/** Claim pending rows until the target work order is in_progress, then complete it. */
function completeWorkOrder(ledger: TaskLedger, id: number): void {
  for (let i = 0; i < 20; i++) {
    const claimed = ledger.claimNextWorkOrder();
    if (!claimed) break;
    if (claimed.id === id) break;
  }
  ledger.completeWorkOrder(id);
}

async function registerWikiRuntime(
  db: Database,
  vaultPath: string,
  options?: {
    connectorConfig?: ConnectorConfigLoadResult;
    rawConnectorScope?: readonly string[];
  }
) {
  const connectorConfig = options?.connectorConfig ?? emptyConnectorConfig;
  const rawScope = options?.rawConnectorScope ?? RAW_CONNECTOR_SCOPE;
  const policy = resolvePrivateConnectorPolicy(connectorConfig);
  const eventBus = new AgentEventBus();
  const toolExecutor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    privateConnectorPolicy: policy,
  });
  const ledger = new TaskLedger(db);
  toolExecutor.setTaskLedger(ledger);
  const apiServer = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: connectorConfig,
    privateConnectorPolicy: policy,
  });

  const routeHandle = await registerApiRoutes({
    config: createWikiConfig(vaultPath),
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
    rawConnectorScope: rawScope,
    boardRefreshGate: null,
    getAdapter: () => db,
    requestFullReport: undefined,
  });

  return { apiServer, eventBus, ledger, routeHandle };
}

function expectTypedWikiPayload(payload: Record<string, unknown>, trigger: string): void {
  expect(payload.ownerDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(payload.range).toMatchObject({
    start_ms: expect.any(Number),
    end_ms: expect.any(Number),
  });
  const range = payload.range as { start_ms: number; end_ms: number };
  expect(range.start_ms).toBeLessThanOrEqual(range.end_ms);
  // C1: task_list.updated_since needs a canonical RFC3339 string for start_ms.
  expect(payload.taskUpdatedSince).toBe(new Date(range.start_ms).toISOString());
  expect(payload.taskUpdatedBefore).toBe(new Date(range.end_ms).toISOString());
  expect(typeof payload.sourceWatermark).toBe('string');
  expect(payload.connectors).toEqual(RAW_CONNECTOR_SCOPE);
  expect(payload.events).toEqual([trigger]);
  // The exact scope the turn passes to contract_no_update: deterministic, from
  // the snapshot (not batchId), and carrying no raw source terms.
  expect(payload.noUpdateScope).toMatch(/^wiki:\d{4}-\d{2}-\d{2}:/);
  expect(String(payload.noUpdateScope)).not.toContain(String(payload.batchId));
}

describe('wiki daily-continuity runtime wiring', () => {
  let testHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed midday UTC keeps the owner date stable across the test's 1-2h ticks.
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
    testHome = mkdtempSync(join(tmpdir(), 'mama-api-routes-wiki-'));
    previousHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  // Owner decision 2026-09-09: a restart is not evidence that the wiki has anything to
  // compile. The boot continuity order is what put a multi-minute maintenance turn in front
  // of the owner's first message after every restart.
  it('boot enqueues NOTHING; the hourly continuity tick is the first run', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { routeHandle } = await registerWikiRuntime(db, join(testHome, 'vault'));

      expect(wikiRows(db)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(wikiRows(db)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      const rows = wikiRows(db);
      expect(rows).toHaveLength(1);
      expectTypedWikiPayload(rows[0].payload, 'hourly');
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('advertises the same public connector scope carried by the wiki envelope', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const privateConfig = {
        ok: true,
        config: { kagemusha: { enabled: true } },
        enabledNames: ['kagemusha'],
      } as ConnectorConfigLoadResult;
      const { routeHandle } = await registerWikiRuntime(db, join(testHome, 'vault'), {
        connectorConfig: privateConfig,
        rawConnectorScope: ['slack', 'kagemusha'],
      });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(wikiRows(db)[0].payload.connectors).toEqual(['slack']);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('an hourly continuity tick enqueues a distinct run once the source snapshot moves', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { routeHandle } = await registerWikiRuntime(db, join(testHome, 'vault'));

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // first hourly tick
      expect(wikiRows(db)).toHaveLength(1);

      // Source movement changes the watermark, so the next tick's idempotency
      // key differs from the still-open first run and a distinct run is enqueued.
      bumpConnectorWatermark(db, 1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      const rows = wikiRows(db);
      expect(rows).toHaveLength(2);
      expectTypedWikiPayload(rows[1].payload, 'hourly');
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('coalesces repeated events with an unchanged snapshot into one open workorder', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { eventBus, routeHandle } = await registerWikiRuntime(db, join(testHome, 'vault'));

      // The debounced extraction event plans against the SAME owner date + source
      // watermark as any other trigger, so ledger dedup keeps one open row.
      eventBus.emit({ type: 'extraction:completed' } as never);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wikiRows(db)).toHaveLength(1);

      // Once the snapshot moves, a later event plans a distinct run.
      bumpConnectorWatermark(db, 1);
      eventBus.emit({ type: 'extraction:completed' } as never);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wikiRows(db)).toHaveLength(2);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('a quiet same-day tick skips once the baseline is completed with the same watermark', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { ledger, eventBus, routeHandle } = await registerWikiRuntime(
        db,
        join(testHome, 'vault')
      );

      eventBus.emit({ type: 'extraction:completed' } as never);
      await vi.advanceTimersByTimeAsync(30_000);
      const first = wikiRows(db);
      expect(first).toHaveLength(1);
      // Complete it so it becomes the DONE baseline for this owner day.
      completeWorkOrder(ledger, first[0].id);

      // No connector/task/memory movement -> same owner date + same watermark.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(wikiRows(db)).toHaveLength(1);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('an extraction:completed event enqueues a typed payload after debounce', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { routeHandle, eventBus } = await registerWikiRuntime(db, join(testHome, 'vault'));

      // Only the event run is planned (there is no boot enqueue any more); assert it
      // carries the typed continuity payload.
      routeHandle.stop();
      eventBus.emit({ type: 'extraction:completed' } as never);
      await vi.advanceTimersByTimeAsync(30_000);

      const rows = wikiRows(db);
      expect(rows).toHaveLength(1);
      expectTypedWikiPayload(rows[0].payload, 'extraction:completed');
    } finally {
      db.close();
    }
  });

  it('the manual route backfills a strict owner date and bypasses the skip', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { ledger, apiServer, eventBus, routeHandle } = await registerWikiRuntime(
        db,
        join(testHome, 'vault')
      );

      eventBus.emit({ type: 'extraction:completed' } as never);
      await vi.advanceTimersByTimeAsync(30_000);
      completeWorkOrder(ledger, wikiRows(db)[0].id); // establish a same-day baseline

      const res = await request(apiServer.app)
        .post('/api/wiki/compile')
        .send({ ownerDate: '2026-09-03' });
      expect(res.status).toBe(200);

      const rows = wikiRows(db);
      expect(rows).toHaveLength(2);
      // Manual forces a run despite the completed same-day baseline, and honours
      // the requested past owner date.
      expect(rows[1].payload.ownerDate).toBe('2026-09-03');
      expect(rows[1].payload.events).toEqual(['manual']);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('the manual route rejects a malformed owner date and enqueues nothing', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { apiServer, routeHandle } = await registerWikiRuntime(db, join(testHome, 'vault'));

      const res = await request(apiServer.app)
        .post('/api/wiki/compile')
        .send({ ownerDate: '2026-9-3' });
      expect(res.status).toBe(400);
      expect(wikiRows(db)).toHaveLength(0);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('the manual route returns a non-2xx error when enqueue fails and never claims success', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { ledger, apiServer, routeHandle } = await registerWikiRuntime(
        db,
        join(testHome, 'vault')
      );
      // Force a ledger-side failure through the real enqueue seam.
      vi.spyOn(ledger, 'enqueueWorkOrder').mockImplementation(() => {
        throw new Error('ledger boom');
      });

      const res = await request(apiServer.app).post('/api/wiki/compile').send({});
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toBeUndefined();
      expect(wikiRows(db)).toHaveLength(0);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('the manual route rejects a future owner date and enqueues nothing', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { apiServer, routeHandle } = await registerWikiRuntime(db, join(testHome, 'vault'));

      const res = await request(apiServer.app)
        .post('/api/wiki/compile')
        .send({ ownerDate: '2027-01-01' });
      expect(res.status).toBe(400);
      expect(wikiRows(db)).toHaveLength(0);
      routeHandle.stop();
    } finally {
      db.close();
    }
  });

  it('stop() clears the wiki continuity timer', async () => {
    const db = new Database(':memory:');
    try {
      createSourceTables(db);
      const { routeHandle } = await registerWikiRuntime(db, join(testHome, 'vault'));

      routeHandle.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(wikiRows(db)).toHaveLength(0);

      // No continuity tick fires after stop.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(wikiRows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
