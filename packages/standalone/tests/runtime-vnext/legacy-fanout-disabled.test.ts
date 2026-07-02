import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentLoop } from '../../src/agent/index.js';
import type { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { ApiServer } from '../../src/api/index.js';
import type { MAMAConfig } from '../../src/cli/config/types.js';
import { registerApiRoutes } from '../../src/cli/runtime/api-routes-init.js';
import { initConnectors } from '../../src/cli/runtime/connector-init.js';
import { initCronScheduler, initHeartbeat } from '../../src/cli/runtime/scheduler-init.js';
import type { OAuthManager } from '../../src/auth/index.js';
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

function makeVNextPlan() {
  return buildVNextBootstrapPlan({
    enabled: true,
    mode: 'bootstrap',
    source: 'env',
  });
}

describe('STORY-VNEXT-PR1-FANOUT-OFF: vNext disables legacy fanout', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mama-vnext-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('AC: startup schedulers are inert in vNext bootstrap mode', () => {
    it('does not load cron jobs from config', () => {
      const result = initCronScheduler(makeConfig(), { vNext: makeVNextPlan() });

      expect(result.scheduler.listJobs()).toEqual([]);
    });

    it('does not start heartbeat, token keep-alive, or health warning timers', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const healthCheckService = {
        setCronScheduler: vi.fn(),
        setHeartbeat: vi.fn(),
        check: vi.fn(),
      };

      const { healthWarningInterval } = initHeartbeat(
        makeConfig(),
        {
          run: vi.fn(),
        } as unknown as AgentLoop,
        null,
        initCronScheduler(makeConfig(), { vNext: makeVNextPlan() }).scheduler,
        healthCheckService,
        { vNext: makeVNextPlan() }
      );

      expect(healthWarningInterval).toBeNull();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(healthCheckService.setCronScheduler).toHaveBeenCalledOnce();
      expect(healthCheckService.setHeartbeat).toHaveBeenCalledOnce();
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
      const app = {
        get: vi.fn(),
        post: vi.fn(),
        use: vi.fn(),
      };
      const apiServer = {
        app,
        reportStore: {
          update: vi.fn(),
          getAllSorted: vi.fn(() => []),
        },
        reportSseClients: new Set(),
      } as unknown as ApiServer;
      const eventBus = Object.assign(new EventEmitter(), {
        emit: vi.fn(),
        getRecentNotices: vi.fn(() => []),
      });
      const toolExecutor = {
        setAgentEventBus: vi.fn(),
        setReportPublisher: vi.fn(),
        setObsidianVaultPath: vi.fn(),
        setWikiPublisher: vi.fn(),
        getAgentProcessManager: vi.fn(),
      } as unknown as GatewayToolExecutor;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      await registerApiRoutes({
        config: makeConfig(),
        apiServer,
        eventBus: eventBus as never,
        oauthManager: {} as OAuthManager,
        mamaApi: {},
        messageRouter: {
          getMemoryAgentStats: vi.fn(() => ({})),
          listSessions: vi.fn(() => []),
          process: vi.fn(),
        } as never,
        agentLoop: {} as AgentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: vi.fn(async () => false),
        getAdapter: vi.fn(() => ({
          prepare: vi.fn(() => ({
            get: vi.fn(() => ({ count: 0 })),
            all: vi.fn(() => []),
          })),
          exec: vi.fn(),
        })),
        vNext: makeVNextPlan(),
      });

      expect(toolExecutor.setReportPublisher).not.toHaveBeenCalled();
      expect(toolExecutor.setObsidianVaultPath).not.toHaveBeenCalled();
      expect(toolExecutor.setWikiPublisher).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it('keeps dashboard and conductor fanout active in legacy mode', async () => {
      const app = {
        get: vi.fn(),
        post: vi.fn(),
        use: vi.fn(),
      };
      const apiServer = {
        app,
        reportStore: {
          update: vi.fn(),
          getAllSorted: vi.fn(() => []),
        },
        reportSseClients: new Set(),
      } as unknown as ApiServer;
      const eventBus = Object.assign(new EventEmitter(), {
        emit: vi.fn(),
        getRecentNotices: vi.fn(() => []),
      });
      const toolExecutor = {
        setAgentEventBus: vi.fn(),
        setReportPublisher: vi.fn(),
        setObsidianVaultPath: vi.fn(),
        setWikiPublisher: vi.fn(),
        getAgentProcessManager: vi.fn(),
      } as unknown as GatewayToolExecutor;
      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>);
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation(
          () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
        );

      await registerApiRoutes({
        config: makeConfig({ wiki: { enabled: false } }),
        apiServer,
        eventBus: eventBus as never,
        oauthManager: {} as OAuthManager,
        mamaApi: {},
        messageRouter: {
          getMemoryAgentStats: vi.fn(() => ({})),
          listSessions: vi.fn(() => []),
          process: vi.fn(),
        } as never,
        agentLoop: {} as AgentLoop,
        toolExecutor,
        discordGateway: null,
        slackGateway: null,
        graphHandler: vi.fn(async () => false),
        getAdapter: vi.fn(() => ({
          prepare: vi.fn(() => ({
            get: vi.fn(() => ({ count: 0 })),
            all: vi.fn(() => []),
          })),
          exec: vi.fn(),
        })),
      });

      expect(toolExecutor.setReportPublisher).toHaveBeenCalledOnce();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
    });
  });
});
