import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentLoop } from '../../../src/agent/index.js';
import type { GraphHandlerOptions } from '../../../src/api/graph-api-types.js';
import type { MAMAConfig } from '../../../src/cli/config/types.js';
import { wireGateways } from '../../../src/cli/runtime/gateway-wiring.js';
import type { MessageRouter } from '../../../src/gateways/message-router.js';
import type { HealthCheckService } from '../../../src/observability/health-check.js';
import type { SQLiteDatabase } from '../../../src/sqlite.js';

const originalHome = process.env.HOME;
const fixtureRoots: string[] = [];
const startKeys: symbol[] = [];

function writeGatewayPlugin(pluginsDir: string, id: string, apiVersion: number): symbol {
  const pluginDir = join(pluginsDir, id);
  mkdirSync(pluginDir);
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      apiVersion,
      id,
      name: `Synthetic ${id}`,
      version: '1.0.0',
      main: 'index.mjs',
      type: 'gateway',
      gateway: { sourceId: 'chatwork', label: `Synthetic ${id}` },
    })
  );
  const startKey = Symbol.for(`mama-test-plugin-start:${pluginsDir}:${id}`);
  startKeys.push(startKey);
  writeFileSync(
    join(pluginDir, 'index.mjs'),
    `const startKey = Symbol.for(${JSON.stringify(Symbol.keyFor(startKey))});
export async function register() {
  return {
    source: 'chatwork',
    async start() { globalThis[startKey] = (globalThis[startKey] ?? 0) + 1; },
    async stop() {},
    isConnected() { return true; },
    onEvent() {},
  };
}
`
  );
  return startKey;
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  for (const startKey of startKeys.splice(0)) {
    delete (globalThis as Record<symbol, unknown>)[startKey];
  }
  vi.restoreAllMocks();
});

describe('gateway plugin wiring isolation', () => {
  it('starts a good plugin when another manifest is rejected and logs the rejection', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mama-gateway-wiring-'));
    fixtureRoots.push(fixtureRoot);
    const pluginsDir = join(fixtureRoot, '.mama', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeGatewayPlugin(pluginsDir, 'rejected', 1);
    const acceptedStartKey = writeGatewayPlugin(pluginsDir, 'accepted', 2);
    process.env.HOME = fixtureRoot;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const gateways: Array<{ stop: () => Promise<void> }> = [];

    await wireGateways({
      config: {} as MAMAConfig,
      messageRouter: { setGatewayRegistry: vi.fn() } as unknown as MessageRouter,
      healthCheckService: { addGateway: vi.fn() } as unknown as HealthCheckService,
      graphHandlerOptions: {} as GraphHandlerOptions,
      db: {} as SQLiteDatabase,
      discordGateway: null,
      slackGateway: null,
      telegramGateway: null,
      gateways,
      agentLoop: {} as AgentLoop,
      cronEmitter: new EventEmitter(),
    });

    expect(gateways).toHaveLength(1);
    expect((globalThis as Record<symbol, unknown>)[acceptedStartKey]).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[PluginLoader] Skipping plugin rejected after load failure:',
      expect.objectContaining({ message: expect.stringMatching(/apiVersion.*2/) })
    );
  });
});
