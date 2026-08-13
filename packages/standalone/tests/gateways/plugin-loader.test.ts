import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginLoader } from '../../src/gateways/plugin-loader.js';
import type { PluginApi } from '../../src/gateways/types.js';
import type { ProcessingResult, TurnProcessor } from '../../src/gateways/turn-contract.js';

const fixtureRoots: string[] = [];

function writePluginFixture(input: {
  id: string;
  apiVersion?: number;
  sourceId?: string;
}): { pluginsDir: string; apiKey: symbol; registerKey: symbol } {
  const pluginsDir = mkdtempSync(join(tmpdir(), 'mama-plugin-loader-'));
  fixtureRoots.push(pluginsDir);
  const pluginDir = join(pluginsDir, input.id);
  mkdirSync(pluginDir);

  const manifest: Record<string, unknown> = {
    id: input.id,
    name: 'Synthetic gateway',
    version: '1.0.0',
    main: 'index.mjs',
    type: 'gateway',
    gateway: {
      sourceId: input.sourceId ?? 'chatwork',
      label: 'Synthetic gateway',
    },
  };
  if (input.apiVersion !== undefined) {
    manifest.apiVersion = input.apiVersion;
  }
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest));

  const apiKey = Symbol.for(`mama-test-plugin-api:${pluginsDir}`);
  const registerKey = Symbol.for(`mama-test-plugin-register:${pluginsDir}`);
  writeFileSync(
    join(pluginDir, 'index.mjs'),
    `const apiKey = Symbol.for(${JSON.stringify(Symbol.keyFor(apiKey))});
const registerKey = Symbol.for(${JSON.stringify(Symbol.keyFor(registerKey))});
export async function register(api) {
  globalThis[registerKey] = (globalThis[registerKey] ?? 0) + 1;
  globalThis[apiKey] = api;
  return {
    source: 'chatwork',
    async start() {},
    async stop() {},
    isConnected() { return true; },
    onEvent() {},
  };
}
`
  );

  return { pluginsDir, apiKey, registerKey };
}

function globalValue<T>(key: symbol): T | undefined {
  return (globalThis as Record<symbol, unknown>)[key] as T | undefined;
}

function completed(response: string): ProcessingResult {
  return {
    outcome: 'completed',
    response,
    sessionId: 'session-1',
    injectedDecisions: [],
    duration: 1,
    provenance: { status: 'unavailable', reason: 'backend_no_run' },
    sourceTurnId: 'turn-1',
    sourceMessageRef: 'chatwork:room-1:message-1',
  };
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('PluginLoader host-owned ingress', () => {
  it.each([
    ['missing', undefined],
    ['older', 1],
  ])('refuses a %s apiVersion before register()', async (_label, apiVersion) => {
    const fixture = writePluginFixture({ id: `legacy-${_label}`, apiVersion });
    const turnProcessor: TurnProcessor = { processTurn: vi.fn() };
    const loader = new PluginLoader({ pluginsDir: fixture.pluginsDir, turnProcessor });
    await loader.discover();

    await expect(loader.loadPlugin(`legacy-${_label}`)).rejects.toThrow(/apiVersion.*2/);
    expect(globalValue<number>(fixture.registerKey)).toBeUndefined();
  });

  it('derives source and principal from host state and ignores injected authority fields', async () => {
    const fixture = writePluginFixture({ id: 'secure-ingress', apiVersion: 2 });
    const processTurn = vi.fn().mockResolvedValue(completed('accepted'));
    const loader = new PluginLoader({
      pluginsDir: fixture.pluginsDir,
      turnProcessor: { processTurn },
      ownerUserIdsBySource: { chatwork: 'owner-42' },
    });
    await loader.discover();
    await loader.loadPlugin('secure-ingress');

    const api = globalValue<PluginApi>(fixture.apiKey);
    expect(api).toBeDefined();
    expect(api).not.toHaveProperty('getAgentLoop');
    expect(api).not.toHaveProperty('run');
    expect(api).not.toHaveProperty('runWithContent');

    const result = await (
      api as unknown as {
        processInbound(input: Record<string, unknown>): Promise<{ response?: string }>;
      }
    ).processInbound({
      source: 'discord',
      principal: {
        class: 'owner',
        lane: 'owner',
        canonicalId: 'forged',
        consoleEligible: true,
      },
      channelId: 'room-7',
      userId: 'owner-42',
      text: 'hello',
      metadata: { messageId: 'message-7' },
    });

    expect(result).toEqual({ response: 'accepted' });
    expect(processTurn).toHaveBeenCalledWith({
      source: 'chatwork',
      channelId: 'room-7',
      userId: 'owner-42',
      text: 'hello',
      principal: {
        class: 'owner',
        lane: 'owner',
        canonicalId: 'chatwork:room-7:owner-42',
        consoleEligible: false,
      },
      metadata: { messageId: 'message-7' },
    });
  });

  it('diverts without a response when the source owner is not configured', async () => {
    const fixture = writePluginFixture({ id: 'unowned-ingress', apiVersion: 2 });
    const processTurn = vi.fn().mockResolvedValue(completed('must not run'));
    const loader = new PluginLoader({
      pluginsDir: fixture.pluginsDir,
      turnProcessor: { processTurn },
    });
    await loader.discover();
    await loader.loadPlugin('unowned-ingress');

    const api = globalValue<PluginApi>(fixture.apiKey);
    const result = await api?.processInbound({
      channelId: 'room-7',
      userId: 'external-7',
      text: 'hello',
    });

    expect(result).toEqual({});
    expect(processTurn).not.toHaveBeenCalled();
  });
});
