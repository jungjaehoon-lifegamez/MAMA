import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentLoop } from '../../src/agent/index.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { createApiServer } from '../../src/api/index.js';
import { OAuthManager } from '../../src/auth/index.js';
import { MessageRouter } from '../../src/gateways/index.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { AgentEventBus } from '../../src/multi-agent/agent-event-bus.js';
import { HealthCheckService } from '../../src/observability/health-check.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import type { MAMAConfig } from '../../src/cli/config/types.js';
import { registerApiRoutes } from '../../src/cli/runtime/api-routes-init.js';
import { initConnectors } from '../../src/cli/runtime/connector-init.js';
import { initCronScheduler, initHeartbeat } from '../../src/cli/runtime/scheduler-init.js';
import { buildVNextBootstrapPlan } from '../../src/runtime-vnext/bootstrap.js';

function makeConfig(overrides: Partial<MAMAConfig> = {}): MAMAConfig {
  return {
    version: 1,
    agent: {
      model: 'claude-sonnet-4-6',
      timeout: 300_000,
      max_turns: 5,
      tools: { gateway: true, mcp: false },
    },
    database: { path: ':memory:' },
    logging: { level: 'info', file: '~/.mama/mama.log' },
    scheduling: {
      jobs: [
        {
          id: 'legacy-cron',
          name: 'Legacy Cron',
          cron: '* * * * *',
          prompt: 'legacy cron fanout',
          enabled: true,
        },
      ],
    },
    heartbeat: { enabled: true, interval: 60_000 },
    wiki: { enabled: true, vaultPath: '/tmp/mama-vnext-wiki' },
    ...overrides,
  } as unknown as MAMAConfig;
}

function makeMultiAgentConfig(
  agents: NonNullable<MAMAConfig['multi_agent']>['agents']
): NonNullable<MAMAConfig['multi_agent']> {
  return {
    enabled: false,
    free_chat: true,
    default_agent: 'conductor',
    agents,
    loop_prevention: {
      max_chain_length: 5,
      global_cooldown_ms: 1000,
      chain_window_ms: 60000,
    },
    workflow: { enabled: true },
    council: { enabled: true },
  };
}

function makeDashboardAgentConfig(): NonNullable<MAMAConfig['multi_agent']>['agents'][string] {
  return {
    name: 'Dashboard Agent',
    display_name: 'Dashboard',
    trigger_prefix: '!dashboard',
    persona_file: '~/.mama/personas/dashboard.md',
    tier: 2,
    backend: 'claude',
    model: 'claude-sonnet-4-6',
    can_delegate: false,
    enabled: true,
    useCodeAct: true,
  };
}

function makeWikiAgentConfig(): NonNullable<MAMAConfig['multi_agent']>['agents'][string] {
  return {
    name: 'Wiki Agent',
    display_name: 'Wiki',
    trigger_prefix: '!wiki',
    persona_file: '~/.mama/personas/wiki.md',
    tier: 2,
    backend: 'claude',
    model: 'claude-sonnet-4-6',
    can_delegate: false,
    enabled: true,
    useCodeAct: true,
  };
}

function makeVNextPlan() {
  return buildVNextBootstrapPlan({
    enabled: true,
    mode: 'bootstrap',
    source: 'env',
  });
}

function makeOAuthManager(home: string): OAuthManager {
  return new OAuthManager({
    credentialsPath: join(home, '.claude', '.credentials.json'),
  });
}

function makeAgentLoop(home: string): AgentLoop {
  return new AgentLoop(makeOAuthManager(home), {
    maxTurns: 1,
    model: 'claude-sonnet-4-6',
    systemPrompt: 'test runtime fanout boundary',
    toolsConfig: { gateway: [], mcp: [] },
  });
}

function makeMessageRouter(db: SQLiteDatabase, home: string): MessageRouter {
  const sessionStore = new SessionStore(db);
  return new MessageRouter(
    sessionStore,
    makeAgentLoop(home),
    {
      search: async () => [],
      listDecisions: async () => [],
      loadCheckpoint: async () => null,
    },
    {}
  );
}

function makeAdapter() {
  return {
    prepare: () => ({
      get: () => ({ count: 0 }),
      all: () => [],
    }),
    exec: () => undefined,
  };
}

describe('STORY-VNEXT-PR1-FANOUT-OFF: vNext disables legacy fanout', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let databases: SQLiteDatabase[];

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mama-vnext-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    databases = [];
  });

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.doUnmock('child_process');
  });

  describe('AC: startup schedulers are inert in vNext bootstrap mode', () => {
    it('does not load cron jobs from config', () => {
      const result = initCronScheduler(makeConfig(), { vNext: makeVNextPlan() });

      expect(result.scheduler.listJobs()).toEqual([]);
    });

    it('does not start heartbeat, token keep-alive, or health warning timers', () => {
      const agentLoop = makeAgentLoop(tempHome);
      const healthCheckService = new HealthCheckService({});
      const setCronSchedulerSpy = vi.spyOn(healthCheckService, 'setCronScheduler');
      const setHeartbeatSpy = vi.spyOn(healthCheckService, 'setHeartbeat');
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      const { healthWarningInterval } = initHeartbeat(
        makeConfig(),
        agentLoop,
        null,
        initCronScheduler(makeConfig(), { vNext: makeVNextPlan() }).scheduler,
        healthCheckService,
        { vNext: makeVNextPlan() }
      );

      expect(healthWarningInterval).toBeNull();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setCronSchedulerSpy).toHaveBeenCalledOnce();
      expect(setHeartbeatSpy).toHaveBeenCalledOnce();
    });

    it('does not create raw stores, auto-enable connectors, or start connector polling', async () => {
      const result = await initConnectors(null, { vNext: makeVNextPlan() });

      expect(result).toEqual({
        rawStoreForApi: undefined,
        enabledConnectorNames: [],
        connectorSchedulerStop: undefined,
      });
    });

    it('keeps cron loading active in legacy mode', () => {
      const result = initCronScheduler(makeConfig());

      expect(result.scheduler.listJobs()).toEqual([
        expect.objectContaining({
          id: 'legacy-cron',
          name: 'Legacy Cron',
          prompt: 'legacy cron fanout',
        }),
      ]);

      result.scheduler.shutdown();
      result.cronWorker.stop().catch(() => {});
    });
  });

  describe('AC: API route registration does not schedule dashboard/wiki/conductor work', () => {
    it('skips persona writes, MCP config rewrites, Obsidian launch, and autonomous timers', async () => {
      const apiServer = createApiServer({
        scheduler: initCronScheduler(makeConfig(), { vNext: makeVNextPlan() }).scheduler,
        port: 0,
      });
      const eventBus = new AgentEventBus();
      const toolExecutor = new GatewayToolExecutor();
      const setReportPublisherSpy = vi.spyOn(toolExecutor, 'setReportPublisher');
      const setObsidianVaultPathSpy = vi.spyOn(toolExecutor, 'setObsidianVaultPath');
      const setWikiPublisherSpy = vi.spyOn(toolExecutor, 'setWikiPublisher');
      const db = new Database(':memory:');
      databases.push(db);
      const messageRouter = makeMessageRouter(db, tempHome);
      const agentLoop = makeAgentLoop(tempHome);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      await registerApiRoutes({
        config: makeConfig(),
        apiServer,
        eventBus,
        oauthManager: makeOAuthManager(tempHome),
        mamaApi: {},
        messageRouter,
        agentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: async () => false,
        getAdapter: makeAdapter,
        vNext: makeVNextPlan(),
      });

      expect(setReportPublisherSpy).not.toHaveBeenCalled();
      expect(setObsidianVaultPathSpy).not.toHaveBeenCalled();
      expect(setWikiPublisherSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it('does not start legacy self-paced agents in legacy mode unless configured', async () => {
      const apiServer = createApiServer({
        scheduler: initCronScheduler(makeConfig()).scheduler,
        port: 0,
      });
      const eventBus = new AgentEventBus();
      const toolExecutor = new GatewayToolExecutor();
      const setReportPublisherSpy = vi.spyOn(toolExecutor, 'setReportPublisher');
      const setObsidianVaultPathSpy = vi.spyOn(toolExecutor, 'setObsidianVaultPath');
      const setWikiPublisherSpy = vi.spyOn(toolExecutor, 'setWikiPublisher');
      const db = new Database(':memory:');
      databases.push(db);
      const messageRouter = makeMessageRouter(db, tempHome);
      const agentLoop = makeAgentLoop(tempHome);
      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>);
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation(
          () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
        );

      await registerApiRoutes({
        config: makeConfig(),
        apiServer,
        eventBus,
        oauthManager: makeOAuthManager(tempHome),
        mamaApi: {},
        messageRouter,
        agentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: async () => false,
        getAdapter: makeAdapter,
      });

      expect(setReportPublisherSpy).not.toHaveBeenCalled();
      expect(setObsidianVaultPathSpy).not.toHaveBeenCalled();
      expect(setWikiPublisherSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 10_000);
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 15_000);
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
    });

    it('does not start explicitly disabled legacy self-paced agents in legacy mode', async () => {
      const apiServer = createApiServer({
        scheduler: initCronScheduler(makeConfig()).scheduler,
        port: 0,
      });
      const eventBus = new AgentEventBus();
      const toolExecutor = new GatewayToolExecutor();
      const setReportPublisherSpy = vi.spyOn(toolExecutor, 'setReportPublisher');
      const setObsidianVaultPathSpy = vi.spyOn(toolExecutor, 'setObsidianVaultPath');
      const setWikiPublisherSpy = vi.spyOn(toolExecutor, 'setWikiPublisher');
      const db = new Database(':memory:');
      databases.push(db);
      const messageRouter = makeMessageRouter(db, tempHome);
      const agentLoop = makeAgentLoop(tempHome);
      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>);
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation(
          () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
        );

      await registerApiRoutes({
        config: makeConfig({
          multi_agent: makeMultiAgentConfig({
            'dashboard-agent': { ...makeDashboardAgentConfig(), enabled: false },
            'wiki-agent': { ...makeWikiAgentConfig(), enabled: false },
          }),
        }),
        apiServer,
        eventBus,
        oauthManager: makeOAuthManager(tempHome),
        mamaApi: {},
        messageRouter,
        agentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: async () => false,
        getAdapter: makeAdapter,
      });

      expect(setReportPublisherSpy).not.toHaveBeenCalled();
      expect(setObsidianVaultPathSpy).not.toHaveBeenCalled();
      expect(setWikiPublisherSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 10_000);
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 15_000);
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
    });

    it('keeps dashboard and conductor fanout active in legacy mode when configured', async () => {
      const apiServer = createApiServer({
        scheduler: initCronScheduler(makeConfig()).scheduler,
        port: 0,
      });
      const eventBus = new AgentEventBus();
      const toolExecutor = new GatewayToolExecutor();
      const setReportPublisherSpy = vi.spyOn(toolExecutor, 'setReportPublisher');
      const db = new Database(':memory:');
      databases.push(db);
      const messageRouter = makeMessageRouter(db, tempHome);
      const agentLoop = makeAgentLoop(tempHome);
      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>);
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation(
          () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
        );

      await registerApiRoutes({
        config: makeConfig({
          wiki: { enabled: false },
          multi_agent: makeMultiAgentConfig({
            'dashboard-agent': makeDashboardAgentConfig(),
          }),
        }),
        apiServer,
        eventBus,
        oauthManager: makeOAuthManager(tempHome),
        mamaApi: {},
        messageRouter,
        agentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: async () => false,
        getAdapter: makeAdapter,
      });

      expect(setReportPublisherSpy).toHaveBeenCalledOnce();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
    });

    it('recreates code-act MCP config when legacy self-paced agent config finds invalid JSON', async () => {
      const mamaDir = join(tempHome, '.mama');
      const mamaMcpConfigPath = join(mamaDir, 'mama-mcp-config.json');
      mkdirSync(mamaDir, { recursive: true });
      writeFileSync(mamaMcpConfigPath, '{ invalid json', 'utf-8');

      const apiServer = createApiServer({
        scheduler: initCronScheduler(makeConfig()).scheduler,
        port: 0,
      });
      const eventBus = new AgentEventBus();
      const toolExecutor = new GatewayToolExecutor();
      const db = new Database(':memory:');
      databases.push(db);
      const messageRouter = makeMessageRouter(db, tempHome);
      const agentLoop = makeAgentLoop(tempHome);
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>
      );
      vi.spyOn(globalThis, 'setInterval').mockImplementation(
        () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
      );

      await registerApiRoutes({
        config: makeConfig({
          wiki: { enabled: false },
          multi_agent: makeMultiAgentConfig({
            'dashboard-agent': makeDashboardAgentConfig(),
          }),
        }),
        apiServer,
        eventBus,
        oauthManager: makeOAuthManager(tempHome),
        mamaApi: {},
        messageRouter,
        agentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: async () => false,
        getAdapter: makeAdapter,
      });

      const mcpConfig = JSON.parse(readFileSync(mamaMcpConfigPath, 'utf-8')) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[]; env?: Record<string, string> }
        >;
      };

      expect(mcpConfig.mcpServers?.['code-act']).toMatchObject({
        command: 'node',
        env: { MAMA_SERVER_PORT: '3847' },
      });
      expect(mcpConfig.mcpServers?.['code-act']?.args?.[0]).toContain('code-act-server.js');
    });

    it('keeps wiki fanout active in legacy mode when wiki-agent is configured', async () => {
      vi.doMock('child_process', () => ({ execSync: vi.fn() }));

      const wikiVault = join(tempHome, 'vault');
      const wikiDir = 'knowledge';
      const apiServer = createApiServer({
        scheduler: initCronScheduler(makeConfig()).scheduler,
        port: 0,
      });
      const eventBus = new AgentEventBus();
      const toolExecutor = new GatewayToolExecutor();
      const setReportPublisherSpy = vi.spyOn(toolExecutor, 'setReportPublisher');
      const setObsidianVaultPathSpy = vi.spyOn(toolExecutor, 'setObsidianVaultPath');
      const setWikiPublisherSpy = vi.spyOn(toolExecutor, 'setWikiPublisher');
      const db = new Database(':memory:');
      databases.push(db);
      const messageRouter = makeMessageRouter(db, tempHome);
      const agentLoop = makeAgentLoop(tempHome);
      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>);
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation(
          () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
        );

      await registerApiRoutes({
        config: makeConfig({
          wiki: { enabled: true, vaultPath: wikiVault, wikiDir },
          multi_agent: makeMultiAgentConfig({
            'wiki-agent': makeWikiAgentConfig(),
          }),
        }),
        apiServer,
        eventBus,
        oauthManager: makeOAuthManager(tempHome),
        mamaApi: {},
        messageRouter,
        agentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: async () => false,
        getAdapter: makeAdapter,
      });

      expect(setReportPublisherSpy).not.toHaveBeenCalled();
      expect(setObsidianVaultPathSpy).toHaveBeenCalledWith(join(wikiVault, wikiDir));
      expect(setWikiPublisherSpy).toHaveBeenCalledOnce();
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 10_000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
    });
  });
});
