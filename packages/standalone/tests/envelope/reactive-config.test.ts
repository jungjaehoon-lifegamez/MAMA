import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MAMAConfig } from '../../src/cli/config/types.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import type { AgentLoopOptions } from '../../src/agent/types.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { MessageRouter, type AgentLoopClient } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import {
  createDefaultReactiveEnvelopeConfig,
  getReactiveRoutePolicy,
  type ReactiveEnvelopeConfig,
} from '../../src/envelope/reactive-config.js';
import { makeAuthorityHarness } from './fixtures.js';

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
    workspace: {
      path: '/workspace/project-a',
      scripts: '/workspace/project-a/scripts',
      data: '/workspace/project-a/data',
    },
    timeouts: {
      request_ms: 120_000,
      codex_request_ms: 120_000,
      initialize_ms: 60_000,
      session_ms: 1_800_000,
      session_cleanup_ms: 300_000,
      agent_ms: 120_000,
      ultrawork_ms: 300_000,
      workflow_step_ms: 600_000,
      workflow_max_ms: 1_800_000,
      busy_retry_ms: 5_000,
    },
    ...overrides,
  } as unknown as MAMAConfig;
}

function makeMessage(
  source: NormalizedMessage['source'],
  channelId = `${source}:1`
): NormalizedMessage {
  return {
    source,
    channelId,
    userId: `${source}:user`,
    text: `hello from ${source}`,
  };
}

describe('reactive envelope route policy', () => {
  it.each([
    {
      source: 'telegram' as const,
      envelopeSource: 'telegram',
      rawConnectors: ['telegram'],
      destination: { kind: 'telegram', id: 'tg:1' },
    },
    {
      source: 'slack' as const,
      envelopeSource: 'slack',
      rawConnectors: ['slack'],
      destination: { kind: 'slack', id: 'slack:1' },
    },
    {
      source: 'chatwork' as const,
      envelopeSource: 'chatwork',
      rawConnectors: ['chatwork'],
      destination: { kind: 'chatwork', id: 'chatwork:1' },
    },
    {
      source: 'discord' as const,
      envelopeSource: 'discord',
      rawConnectors: ['discord'],
      destination: { kind: 'discord', id: 'discord:1' },
    },
    {
      source: 'viewer' as const,
      envelopeSource: 'viewer',
      rawConnectors: [],
      destination: { kind: 'webchat', id: 'viewer:1' },
    },
    {
      source: 'mobile' as const,
      envelopeSource: 'viewer',
      rawConnectors: [],
      destination: { kind: 'webchat', id: 'mobile:1' },
    },
    {
      source: 'system' as const,
      envelopeSource: 'watch',
      rawConnectors: [],
      destination: undefined,
    },
  ])(
    'derives one route policy for $source reactive messages',
    ({ source, envelopeSource, rawConnectors, destination }) => {
      const channelId = destination?.id ?? 'system:1';
      const config = makeConfig();
      const env = { HOME: '/tmp/mama-home' };
      const message = makeMessage(source, channelId);

      const policy = getReactiveRoutePolicy(message, config, env);
      const reactiveConfig = createDefaultReactiveEnvelopeConfig(config, env);

      expect(policy.source).toBe(envelopeSource);
      expect(policy.rawConnectors).toEqual(rawConnectors);
      expect(policy.allowedDestinations).toEqual(destination ? [destination] : []);
      expect(policy.memoryScopes).toEqual(
        expect.arrayContaining([
          { kind: 'project', id: '/workspace/project-a' },
          { kind: 'channel', id: `${envelopeSource}:${channelId}` },
          { kind: 'user', id: `${source}:user` },
        ])
      );
      expect(reactiveConfig.projectRefsFor(message)).toEqual(policy.projectRefs);
      expect(reactiveConfig.rawConnectorsFor(message)).toEqual(policy.rawConnectors);
      expect(reactiveConfig.memoryScopesFor(message)).toEqual(policy.memoryScopes);
      expect(reactiveConfig.reactiveBudgetSeconds).toBe(policy.reactiveBudgetSeconds);
    }
  );

  it('does not treat partial reactive config objects without a budget as reactive config', () => {
    const partialReactiveConfig = {
      projectRefsFor: () => {
        throw new Error('partial reactive config should not be used');
      },
      rawConnectorsFor: () => {
        throw new Error('partial reactive config should not be used');
      },
      memoryScopesFor: () => {
        throw new Error('partial reactive config should not be used');
      },
    } as unknown as MAMAConfig | ReactiveEnvelopeConfig;

    const policy = getReactiveRoutePolicy(
      makeMessage('telegram', 'tg:partial'),
      partialReactiveConfig,
      { HOME: '/tmp/mama-home' }
    );

    expect(policy.projectRefs).toEqual([
      { kind: 'project', id: resolve('/tmp/mama-home/.mama/workspace') },
    ]);
    expect(policy.reactiveBudgetSeconds).toBe(300);
  });

  it('keeps MessageRouter envelope scope behavior aligned with shared route policy', async () => {
    const db: SQLiteDatabase = new Database(':memory:');
    const sessionStore = new SessionStore(db);
    const config = makeConfig();
    const env = { HOME: '/tmp/mama-home' };
    const message = makeMessage('telegram', 'tg:policy');
    const expectedPolicy = getReactiveRoutePolicy(message, config, env);
    const { authority } = makeAuthorityHarness(db);
    let seenOptions: AgentLoopOptions | undefined;
    const agentLoop: AgentLoopClient = {
      async run(_prompt, options) {
        seenOptions = options;
        return { response: 'ok' };
      },
    };

    const router = new MessageRouter(
      sessionStore,
      agentLoop,
      createMockMamaApi([]),
      {},
      createDefaultReactiveEnvelopeConfig(config, env),
      authority
    );

    await router.process(message);

    expect(seenOptions?.envelope?.source).toBe(expectedPolicy.source);
    expect(seenOptions?.envelope?.scope.project_refs).toEqual(expectedPolicy.projectRefs);
    expect(seenOptions?.envelope?.scope.raw_connectors).toEqual(expectedPolicy.rawConnectors);
    expect(seenOptions?.envelope?.scope.memory_scopes).toEqual(expectedPolicy.memoryScopes);
    expect(seenOptions?.envelope?.scope.allowed_destinations).toEqual(
      expectedPolicy.allowedDestinations
    );
    sessionStore.close();
  });

  it('resolves project scope from config workspace without daemon cwd fallback', () => {
    const config = makeConfig({
      workspace: {
        path: '$HOME/reactive-project',
        scripts: '$HOME/reactive-project/scripts',
        data: '$HOME/reactive-project/data',
      },
    });

    const policy = getReactiveRoutePolicy(makeMessage('telegram', 'tg:1'), config, {
      HOME: '/tmp/mama-home',
      MAMA_WORKSPACE: '/tmp/ignored-workspace',
    });

    expect(policy.projectRefs).toEqual([
      { kind: 'project', id: '/tmp/mama-home/reactive-project' },
    ]);
    expect(policy.memoryScopes).toContainEqual({
      kind: 'project',
      id: '/tmp/mama-home/reactive-project',
    });
    expect(policy.projectRefs[0].id).not.toBe('');
    expect(policy.projectRefs[0].id).not.toBe(process.cwd());
  });

  it('falls back to MAMA_WORKSPACE, then HOME workspace, without using process.cwd()', () => {
    const noWorkspaceConfig = makeConfig({ workspace: undefined });

    expect(
      getReactiveRoutePolicy(makeMessage('telegram', 'tg:1'), noWorkspaceConfig, {
        HOME: '/tmp/mama-home',
        MAMA_WORKSPACE: '/tmp/mama-workspace',
      }).projectRefs
    ).toEqual([{ kind: 'project', id: '/tmp/mama-workspace' }]);

    const fallback = getReactiveRoutePolicy(makeMessage('telegram', 'tg:1'), noWorkspaceConfig, {
      HOME: '/tmp/mama-home',
    });
    expect(fallback.projectRefs).toEqual([
      { kind: 'project', id: resolve('/tmp/mama-home/.mama/workspace') },
    ]);
    expect(fallback.projectRefs[0].id).not.toBe(process.cwd());
  });

  it('rejects malformed explicit workspace values', () => {
    expect(() =>
      createDefaultReactiveEnvelopeConfig(
        makeConfig({
          workspace: {
            path: '',
            scripts: '',
            data: '',
          },
        }),
        { HOME: '/tmp/mama-home' }
      )
    ).toThrow(/workspace/i);
  });

  it('derives a finite positive budget from config, otherwise defaults to 300 seconds', () => {
    expect(
      createDefaultReactiveEnvelopeConfig(
        makeConfig({
          timeouts: {
            ...(makeConfig().timeouts as NonNullable<MAMAConfig['timeouts']>),
            agent_ms: 90_000,
          },
        }),
        { HOME: '/tmp/mama-home' }
      ).reactiveBudgetSeconds
    ).toBe(90);

    expect(
      createDefaultReactiveEnvelopeConfig(
        makeConfig({
          timeouts: {
            ...(makeConfig().timeouts as NonNullable<MAMAConfig['timeouts']>),
            agent_ms: Number.POSITIVE_INFINITY,
          },
        }),
        { HOME: '/tmp/mama-home' }
      ).reactiveBudgetSeconds
    ).toBe(300);
  });
});
