/**
 * The owner persona's code-act MCP entry is not a legacy multi-agent feature.
 *
 * Personas were retired, so `dashboard-agent` / `wiki-agent` are no longer
 * configured on a normal install. The claude persona is still spawned with
 * `--mcp-config ~/.mama/mama-mcp-config.json --strict-mcp-config`, so the boot
 * merge must happen for the claude backend regardless of those legacy agents —
 * otherwise the persona starts with no gateway tools at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { TaskLedger } from '../../../src/operator/task-ledger.js';
import { CronScheduler } from '../../../src/scheduler/cron-scheduler.js';
import Database from '../../../src/sqlite.js';
import type { OAuthManager } from '../../../src/auth/index.js';

const emptyConnectorConfig: ConnectorConfigLoadResult = {
  ok: true,
  config: {},
  enabledNames: [],
};

/** A config with NO multi_agent agents at all — the retired-persona baseline. */
function createConfig(backend: 'claude' | 'codex'): MAMAConfig {
  return {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, backend },
    database: { ...DEFAULT_CONFIG.database },
    logging: { ...DEFAULT_CONFIG.logging },
    multi_agent: undefined,
  } as MAMAConfig;
}

async function boot(db: Database, backend: 'claude' | 'codex') {
  const policy = resolvePrivateConnectorPolicy(emptyConnectorConfig);
  const toolExecutor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    privateConnectorPolicy: policy,
  });
  toolExecutor.setTaskLedger(new TaskLedger(db));
  const apiServer = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: emptyConnectorConfig,
    privateConnectorPolicy: policy,
  });
  return registerApiRoutes({
    config: createConfig(backend),
    apiServer,
    eventBus: new AgentEventBus(),
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
    rawConnectorScope: [],
    boardRefreshGate: null,
    getAdapter: () => db,
    requestFullReport: undefined,
  });
}

describe('code-act MCP entry at boot (no legacy agent configured)', () => {
  let testHome: string;
  let previousHome: string | undefined;
  let db: Database;
  let mcpConfigPath: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'mama-api-routes-codeact-'));
    previousHome = process.env.HOME;
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.mama'), { recursive: true });
    mcpConfigPath = join(testHome, '.mama', 'mama-mcp-config.json');
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('writes the code-act entry on the claude backend with no dashboard/wiki agent', async () => {
    const handle = await boot(db, 'claude');
    try {
      expect(existsSync(mcpConfigPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as {
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      };
      const entry = parsed.mcpServers?.['code-act'];
      expect(entry?.command).toBe('node');
      expect(entry?.args?.[0]).toMatch(/code-act-server\.js$/);
    } finally {
      handle?.stop?.();
    }
  });

  it('does not write the entry on a non-claude backend', async () => {
    const handle = await boot(db, 'codex');
    try {
      expect(existsSync(mcpConfigPath)).toBe(false);
    } finally {
      handle?.stop?.();
    }
  });
});
