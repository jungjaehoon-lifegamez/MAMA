import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { projectCodeActToolPolicy } from '../../src/agent/code-act/tool-policy.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type {
  AgentLoopOptions,
  GatewayToolExecutionContext,
  MAMAApiInterface,
} from '../../src/agent/types.js';
import { resetRoleManager } from '../../src/agent/role-manager.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import {
  resolveMemberEffectiveScope,
  type MemberEffectiveScope,
} from '../../src/gateways/member-effective-scope.js';
import {
  MessageRouter,
  type AgentLoopClient,
  type ReactiveEnvelopeConfig,
} from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import Database from '../../src/sqlite.js';
import { makeAuthorityHarness, makeSignedEnvelope } from '../envelope/fixtures.js';

const MEMBER_PRINCIPAL = Object.freeze({
  class: 'member' as const,
  lane: 'public' as const,
  canonicalId: 'telegram:global:member-external-id',
  principalId: 'principal-member',
  consoleEligible: false,
});

const MEMBER_SCOPE: MemberEffectiveScope = resolveMemberEffectiveScope({
  principal: MEMBER_PRINCIPAL,
  current: { connector: 'telegram', lane: 'public', channelId: 'member-channel' },
  configuredGrant: { trello: ['team-board'] },
  principalGrants: [
    {
      targetPrincipalId: 'principal-member',
      scope: { kind: 'source', connector: 'trello', channelId: 'team-board' },
      grantedByPrincipalId: 'principal-owner',
      createdAt: 1,
    },
    {
      targetPrincipalId: 'principal-member',
      scope: { kind: 'memory', scopeKind: 'project', scopeId: 'project-team-alpha' },
      grantedByPrincipalId: 'principal-owner',
      createdAt: 2,
    },
  ],
});

const MEMBER_READ_TOOLS = [
  'mama_search',
  'mama_recall',
  'mama_provenance',
  'context_compile',
  'code_act',
];

function memberMessage(): NormalizedMessage {
  return {
    source: 'telegram',
    channelId: 'member-channel',
    userId: 'member-external-id',
    text: 'summarize the granted project evidence',
    principal: MEMBER_PRINCIPAL,
  };
}

function reactiveConfig(): ReactiveEnvelopeConfig {
  return {
    projectRefsFor: () => [{ kind: 'project', id: 'configured-but-ungranted-project' }],
    rawConnectorsFor: () => ['telegram', 'trello', 'drive'],
    memoryScopesFor: () => [{ kind: 'global', id: 'system' }],
    allowedDestinationsFor: (message) => [{ kind: 'telegram', id: message.channelId }],
    reactiveBudgetSeconds: 30,
  };
}

function memberReadApi(): MAMAApiInterface {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'unused', type: 'decision' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true, id: 'unused', type: 'checkpoint' }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true, message: 'unused' }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    recallMemory: vi.fn().mockResolvedValue({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'member', scope_order: [], retrieval_sources: [] },
    }),
  };
}

describe('Phase 2b Task 4 member enforcement snapshot', () => {
  afterEach(() => {
    resetRoleManager();
  });

  it('TG-04/TG-05 projects one internal read-only member policy and builds its envelope from the exact snapshot', async () => {
    const db = new Database(':memory:');
    const sessionStore = new SessionStore(db);
    const { authority } = makeAuthorityHarness(db);
    const captured: AgentLoopOptions[] = [];
    const agentLoop: AgentLoopClient = {
      childRuntimeToolCapable: false,
      async run(_prompt, options) {
        if (options) {
          captured.push(options);
        }
        return { response: 'member response' };
      },
    };
    const router = new MessageRouter(
      sessionStore,
      agentLoop,
      createMockMamaApi([]),
      { backend: 'codex' },
      reactiveConfig(),
      authority,
      { memberScopeResolver: () => MEMBER_SCOPE }
    );

    await router.process(memberMessage());

    expect(captured).toHaveLength(1);
    const options = captured[0]!;
    expect(options.memberEffectiveScope).toBe(MEMBER_SCOPE);
    expect(options.memberScopeRequired).toBe(true);
    expect(options.agentContext).toMatchObject({
      roleName: 'public_lane',
      tier: 2,
      role: {
        allowedTools: MEMBER_READ_TOOLS,
        allowedPaths: [],
        systemControl: false,
        sensitiveAccess: false,
      },
    });
    expect(options.systemPrompt).toContain('host-authorized scoped read context');
    expect(options.systemPrompt).not.toContain('You have no tools');
    expect(options.envelope).toMatchObject({
      source: 'telegram',
      channel_id: 'member-channel',
      tier: 2,
      scope: {
        raw_connectors: ['telegram', 'trello'],
        memory_scopes: [
          { kind: 'project', id: 'project-team-alpha' },
          { kind: 'user', id: 'principal-member' },
        ],
        project_refs: [{ kind: 'project', id: 'project-team-alpha' }],
        allowed_destinations: [{ kind: 'telegram', id: 'member-channel' }],
      },
    });
    const projectedCatalog = projectCodeActToolPolicy({
      tier: 2,
      roleName: options.agentContext?.roleName,
      role: options.agentContext?.role,
      envelopeDestinationKinds: options.envelope?.scope.allowed_destinations.map(
        (destination) => destination.kind
      ),
      envelopeRawConnectors: options.envelope?.scope.raw_connectors,
    });
    expect(projectedCatalog.names).toEqual([
      'context_compile',
      'mama_provenance',
      'mama_recall',
      'mama_search',
    ]);
    expect(projectedCatalog.names).not.toEqual(
      expect.arrayContaining(['mama_save', 'telegram_send', 'Write', 'Bash', 'delegate'])
    );
    sessionStore.close();
  });

  it('fails an empty member snapshot closed before model execution', async () => {
    const db = new Database(':memory:');
    const sessionStore = new SessionStore(db);
    const { authority } = makeAuthorityHarness(db);
    const run = vi.fn().mockResolvedValue({ response: 'must not run' });
    const emptyScope = Object.freeze({
      channelGrant: Object.freeze({}),
      memoryScopes: Object.freeze([]),
      fingerprint: 'd'.repeat(64),
    });
    const router = new MessageRouter(
      sessionStore,
      { childRuntimeToolCapable: false, run },
      createMockMamaApi([]),
      { backend: 'codex' },
      reactiveConfig(),
      authority,
      { memberScopeResolver: () => emptyScope }
    );

    await expect(router.process(memberMessage())).rejects.toThrow(
      'Member effective scope snapshot is empty or invalid'
    );
    expect(run).not.toHaveBeenCalled();
    sessionStore.close();
  });

  it.each([
    {
      name: 'forged fingerprint',
      scope: Object.freeze({ ...MEMBER_SCOPE, fingerprint: 'f'.repeat(64) }),
    },
    {
      name: 'non-frozen channel array',
      scope: Object.freeze({
        ...MEMBER_SCOPE,
        channelGrant: Object.freeze({
          telegram: ['member-channel'],
          trello: Object.freeze(['team-board']),
        }),
      }),
    },
    {
      name: 'sparse channel array',
      scope: Object.freeze({
        ...MEMBER_SCOPE,
        channelGrant: Object.freeze({
          telegram: Object.freeze(Object.assign(new Array<string>(1), {})),
          trello: Object.freeze(['team-board']),
        }),
      }),
    },
    {
      name: 'duplicate channel entry',
      scope: Object.freeze({
        ...MEMBER_SCOPE,
        channelGrant: Object.freeze({
          telegram: Object.freeze(['member-channel', 'member-channel']),
          trello: Object.freeze(['team-board']),
        }),
      }),
    },
    {
      name: 'prototype-shaped channel grant',
      scope: Object.freeze({
        ...MEMBER_SCOPE,
        channelGrant: Object.freeze(
          Object.assign(Object.create({ drive: ['private-root'] }), {
            telegram: Object.freeze(['member-channel']),
            trello: Object.freeze(['team-board']),
          })
        ),
      }),
    },
    {
      name: 'custom-prototype channel array',
      scope: (() => {
        const channels = ['member-channel'];
        const prototype = Object.create(Array.prototype) as Record<string, unknown>;
        Object.assign(prototype, {
          every: () => true,
          includes: () => true,
        });
        Object.setPrototypeOf(channels, prototype);
        Object.freeze(channels);
        const channelGrant = Object.create(null) as Record<string, readonly string[]>;
        channelGrant.telegram = channels;
        channelGrant.trello = MEMBER_SCOPE.channelGrant.trello;
        Object.freeze(channelGrant);
        return Object.freeze({ ...MEMBER_SCOPE, channelGrant });
      })(),
    },
    {
      name: 'own-method channel array',
      scope: (() => {
        const channels = ['member-channel'];
        Object.defineProperty(channels, 'includes', {
          value: () => true,
          enumerable: false,
        });
        Object.freeze(channels);
        const channelGrant = Object.create(null) as Record<string, readonly string[]>;
        channelGrant.telegram = channels;
        channelGrant.trello = MEMBER_SCOPE.channelGrant.trello;
        Object.freeze(channelGrant);
        return Object.freeze({ ...MEMBER_SCOPE, channelGrant });
      })(),
    },
    {
      name: 'custom-prototype memoryScopes array',
      scope: (() => {
        const memoryScopes = [...MEMBER_SCOPE.memoryScopes];
        const prototype = Object.create(Array.prototype) as Record<string, unknown>;
        Object.assign(prototype, {
          every: () => true,
          map: () => [{ kind: 'global', id: 'owner-private' }],
        });
        Object.setPrototypeOf(memoryScopes, prototype);
        Object.freeze(memoryScopes);
        return Object.freeze({ ...MEMBER_SCOPE, memoryScopes });
      })(),
    },
    {
      name: 'own-method memoryScopes array',
      scope: (() => {
        const memoryScopes = [...MEMBER_SCOPE.memoryScopes];
        Object.defineProperty(memoryScopes, 'map', {
          value: () => [{ kind: 'global', id: 'owner-private' }],
          enumerable: false,
        });
        Object.freeze(memoryScopes);
        return Object.freeze({ ...MEMBER_SCOPE, memoryScopes });
      })(),
    },
    {
      name: 'custom-prototype memory scope record',
      scope: (() => {
        const first = Object.create({ inheritedAuthority: 'owner-private' }) as {
          kind: 'project';
          id: string;
        };
        first.kind = 'project';
        first.id = 'project-team-alpha';
        Object.freeze(first);
        const memoryScopes = Object.freeze([first, MEMBER_SCOPE.memoryScopes[1]]);
        return Object.freeze({ ...MEMBER_SCOPE, memoryScopes });
      })(),
    },
    {
      name: 'own-method memory scope record',
      scope: (() => {
        const first = { kind: 'project' as const, id: 'project-team-alpha' };
        Object.defineProperty(first, 'toJSON', {
          value: () => ({ kind: 'project', id: 'project-team-alpha' }),
          enumerable: false,
        });
        Object.freeze(first);
        const memoryScopes = Object.freeze([first, MEMBER_SCOPE.memoryScopes[1]]);
        return Object.freeze({ ...MEMBER_SCOPE, memoryScopes });
      })(),
    },
    {
      name: 'custom-prototype outer snapshot',
      scope: (() => {
        const scope = { ...MEMBER_SCOPE };
        Object.setPrototypeOf(scope, { inheritedAuthority: 'owner-private' });
        return Object.freeze(scope);
      })(),
    },
    { name: 'missing snapshot', scope: undefined },
  ] as const)('rejects a $name member snapshot before model execution', async ({ scope }) => {
    const db = new Database(':memory:');
    const sessionStore = new SessionStore(db);
    const { authority } = makeAuthorityHarness(db);
    const run = vi.fn().mockResolvedValue({ response: 'must not run' });
    const router = new MessageRouter(
      sessionStore,
      { childRuntimeToolCapable: false, run },
      createMockMamaApi([]),
      { backend: 'codex' },
      reactiveConfig(),
      authority,
      { memberScopeResolver: () => scope as MemberEffectiveScope }
    );

    await expect(router.process(memberMessage())).rejects.toThrow(
      'Member effective scope snapshot is empty or invalid'
    );
    expect(run).not.toHaveBeenCalled();
    sessionStore.close();
  });

  it('carries the exact member channel grant through AgentLoop execution context', () => {
    const context = buildAgentToolExecutionContext({
      source: 'telegram',
      channelId: 'member-channel',
      memberEffectiveScope: MEMBER_SCOPE,
      memberScopeRequired: true,
      agentContext: {
        source: 'telegram',
        platform: 'telegram',
        roleName: 'public_lane',
        role: {
          model: 'gpt-5.4',
          maxTurns: 4,
          allowedTools: MEMBER_READ_TOOLS,
          allowedPaths: [],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: { sessionId: 'member-session', startedAt: new Date() },
        capabilities: MEMBER_READ_TOOLS,
        limitations: [],
        tier: 2,
        backend: 'codex',
      },
    });

    expect(context?.channelGrantSnapshot).toBe(MEMBER_SCOPE.channelGrant);
    expect(context?.memberScopeRequired).toBe(true);
  });

  it.each(['mama_search', 'code_act'] as const)(
    'denies member-required %s when the snapshot is missing without reading the live provider',
    async (toolName) => {
      const api = memberReadApi();
      const channelGrantProvider = vi.fn(() => ({ trello: ['owner-live-board'] }));
      const executor = new GatewayToolExecutor({
        mamaApi: api,
        channelGrantProvider,
        envelopeIssuanceMode: 'enabled',
      });
      const context: GatewayToolExecutionContext = {
        agentId: 'member',
        source: 'telegram',
        channelId: 'member-channel',
        agentContext: {
          source: 'telegram',
          platform: 'telegram',
          roleName: 'public_lane',
          role: {
            model: 'gpt-5.4',
            maxTurns: 4,
            allowedTools: MEMBER_READ_TOOLS,
            allowedPaths: [],
            systemControl: false,
            sensitiveAccess: false,
          },
          session: { sessionId: 'member-session', startedAt: new Date() },
          capabilities: MEMBER_READ_TOOLS,
          limitations: [],
          tier: 2,
          backend: 'codex',
        },
        envelope: makeSignedEnvelope({
          source: 'telegram',
          channel_id: 'member-channel',
          tier: 2,
          scope: {
            project_refs: [{ kind: 'project', id: 'project-team-alpha' }],
            raw_connectors: ['telegram', 'trello'],
            memory_scopes: [
              { kind: 'user', id: 'principal-member' },
              { kind: 'project', id: 'project-team-alpha' },
            ],
            allowed_destinations: [{ kind: 'telegram', id: 'member-channel' }],
          },
        }),
        executionSurface: 'model_tool',
        memberScopeRequired: true,
      };

      const result = await executor.execute(
        toolName,
        toolName === 'code_act'
          ? { code: `mama_search({ query: 'must not inherit owner scope' })` }
          : { query: 'must not inherit owner scope' },
        context
      );

      expect(result).toMatchObject({ success: false, code: 'member_scope_missing' });
      expect(channelGrantProvider).not.toHaveBeenCalled();
      expect(api.suggest).not.toHaveBeenCalled();
    }
  );

  it('uses the member snapshot for a real read call without re-reading the live grant provider', async () => {
    const api = memberReadApi();
    const channelGrantProvider = vi.fn(() => ({ telegram: ['owner-live-channel'] }));
    const executor = new GatewayToolExecutor({
      mamaApi: api,
      channelGrantProvider,
      envelopeIssuanceMode: 'enabled',
    });
    const context: GatewayToolExecutionContext = {
      agentId: 'member',
      source: 'telegram',
      channelId: 'member-channel',
      agentContext: {
        source: 'telegram',
        platform: 'telegram',
        roleName: 'public_lane',
        role: {
          model: 'gpt-5.4',
          maxTurns: 4,
          allowedTools: MEMBER_READ_TOOLS,
          allowedPaths: [],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: { sessionId: 'member-session', startedAt: new Date() },
        capabilities: MEMBER_READ_TOOLS,
        limitations: [],
        tier: 2,
        backend: 'codex',
      },
      envelope: makeSignedEnvelope({
        source: 'telegram',
        channel_id: 'member-channel',
        tier: 2,
        scope: {
          project_refs: [{ kind: 'project', id: 'project-team-alpha' }],
          raw_connectors: ['telegram', 'trello'],
          memory_scopes: [
            { kind: 'user', id: 'principal-member' },
            { kind: 'project', id: 'project-team-alpha' },
          ],
          allowed_destinations: [{ kind: 'telegram', id: 'member-channel' }],
        },
      }),
      executionSurface: 'model_tool',
      channelGrantSnapshot: MEMBER_SCOPE.channelGrant,
    };

    await expect(
      executor.execute('mama_search', { query: 'member evidence' }, context)
    ).resolves.toMatchObject({
      success: true,
    });
    expect(channelGrantProvider).not.toHaveBeenCalled();
    expect(api.suggest).toHaveBeenCalledWith(
      'member evidence',
      expect.objectContaining({
        scopes: [
          { kind: 'user', id: 'principal-member' },
          { kind: 'project', id: 'project-team-alpha' },
          { kind: 'channel', id: 'telegram:member-channel' },
          { kind: 'channel', id: 'trello:team-board' },
        ],
      })
    );
  });

  it('passes the same member snapshot through GatewayToolExecutor into context compile', async () => {
    const channelGrantProvider = vi.fn(() => ({ trello: ['owner-live-board'] }));
    const compileAndPersistContext = vi.fn(async () => ({
      packet: {
        packet_id: 'ctxp_member_snapshot',
        task: 'compile granted work',
        scopes: [{ kind: 'channel', id: 'trello:team-board' }],
        source_refs: [],
      },
      record: {},
      modelRunId: 'mr_member_snapshot',
      parentModelRunId: null,
    }));
    const executor = new GatewayToolExecutor({
      mamaApi: memberReadApi(),
      channelGrantProvider,
      contextCompileService: { compileAndPersistContext } as never,
      envelopeIssuanceMode: 'enabled',
    });
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'member-channel',
      tier: 2,
      scope: {
        project_refs: [{ kind: 'project', id: 'project-team-alpha' }],
        raw_connectors: ['telegram', 'trello'],
        memory_scopes: [
          { kind: 'user', id: 'principal-member' },
          { kind: 'project', id: 'project-team-alpha' },
        ],
        allowed_destinations: [{ kind: 'telegram', id: 'member-channel' }],
      },
    });

    const result = await executor.execute(
      'context_compile',
      {
        task: 'compile granted work',
        scopes: [{ kind: 'channel', id: 'trello:team-board' }],
      },
      {
        agentId: 'member',
        source: 'telegram',
        channelId: 'member-channel',
        agentContext: {
          source: 'telegram',
          platform: 'telegram',
          roleName: 'public_lane',
          role: {
            model: 'gpt-5.4',
            maxTurns: 4,
            allowedTools: MEMBER_READ_TOOLS,
            allowedPaths: [],
            systemControl: false,
            sensitiveAccess: false,
          },
          session: { sessionId: 'member-session', startedAt: new Date() },
          capabilities: MEMBER_READ_TOOLS,
          limitations: [],
          tier: 2,
          backend: 'codex',
        },
        envelope,
        executionSurface: 'model_tool',
        channelGrantSnapshot: MEMBER_SCOPE.channelGrant,
      }
    );

    expect(result).toMatchObject({ success: true, packet_id: 'ctxp_member_snapshot' });
    expect(channelGrantProvider).not.toHaveBeenCalled();
    expect(compileAndPersistContext).toHaveBeenCalledOnce();
    expect(compileAndPersistContext.mock.calls[0]?.[0].channelGrantSnapshot).toBe(
      MEMBER_SCOPE.channelGrant
    );
  });

  it('keeps the member snapshot through bounded Code-Act transport without a provider read', async () => {
    const api = memberReadApi();
    const channelGrantProvider = vi.fn(() => ({ trello: ['owner-live-board'] }));
    const executor = new GatewayToolExecutor({
      mamaApi: api,
      channelGrantProvider,
      envelopeIssuanceMode: 'enabled',
    });
    const context: GatewayToolExecutionContext = {
      agentId: 'member',
      source: 'telegram',
      channelId: 'member-channel',
      agentContext: {
        source: 'telegram',
        platform: 'telegram',
        roleName: 'public_lane',
        role: {
          model: 'gpt-5.4',
          maxTurns: 4,
          allowedTools: MEMBER_READ_TOOLS,
          allowedPaths: [],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: { sessionId: 'member-session', startedAt: new Date() },
        capabilities: MEMBER_READ_TOOLS,
        limitations: [],
        tier: 2,
        backend: 'codex',
      },
      envelope: makeSignedEnvelope({
        source: 'telegram',
        channel_id: 'member-channel',
        tier: 2,
        scope: {
          project_refs: [{ kind: 'project', id: 'project-team-alpha' }],
          raw_connectors: ['telegram', 'trello'],
          memory_scopes: [
            { kind: 'user', id: 'principal-member' },
            { kind: 'project', id: 'project-team-alpha' },
          ],
          allowed_destinations: [{ kind: 'telegram', id: 'member-channel' }],
        },
      }),
      executionSurface: 'model_tool',
      channelGrantSnapshot: MEMBER_SCOPE.channelGrant,
    };

    const result = await executor.execute(
      'code_act',
      { code: `mama_search({ query: 'nested member evidence' })` },
      context
    );

    expect(result).toMatchObject({ success: true });
    expect(channelGrantProvider).not.toHaveBeenCalled();
    expect(api.suggest).toHaveBeenCalledWith(
      'nested member evidence',
      expect.objectContaining({
        scopes: expect.arrayContaining([
          { kind: 'user', id: 'principal-member' },
          { kind: 'project', id: 'project-team-alpha' },
          { kind: 'channel', id: 'trello:team-board' },
        ]),
      })
    );
  });

  it('denies mirror-derived memory writes and transport delivery before any side effect', async () => {
    const api = memberReadApi();
    const channelGrantProvider = vi.fn(() => ({ trello: ['owner-live-board'] }));
    const executor = new GatewayToolExecutor({
      mamaApi: api,
      channelGrantProvider,
      envelopeIssuanceMode: 'enabled',
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    executor.setTelegramGateway({
      sendMessage,
      sendFile: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
      sendSticker: vi.fn().mockResolvedValue(true),
    });
    const context: GatewayToolExecutionContext = {
      agentId: 'member',
      source: 'telegram',
      channelId: 'member-channel',
      agentContext: {
        source: 'telegram',
        platform: 'telegram',
        roleName: 'public_lane',
        role: {
          model: 'gpt-5.4',
          maxTurns: 4,
          allowedTools: MEMBER_READ_TOOLS,
          blockedTools: ['mama_save', 'mama_update', 'telegram_send'],
          allowedPaths: [],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: { sessionId: 'member-session', startedAt: new Date() },
        capabilities: MEMBER_READ_TOOLS,
        limitations: [],
        tier: 2,
        backend: 'codex',
      },
      envelope: makeSignedEnvelope({
        source: 'telegram',
        channel_id: 'member-channel',
        tier: 2,
        scope: {
          project_refs: [{ kind: 'project', id: 'project-team-alpha' }],
          raw_connectors: ['telegram', 'trello'],
          memory_scopes: [
            { kind: 'user', id: 'principal-member' },
            { kind: 'project', id: 'project-team-alpha' },
          ],
          allowed_destinations: [{ kind: 'telegram', id: 'member-channel' }],
        },
      }),
      executionSurface: 'model_tool',
      channelGrantSnapshot: MEMBER_SCOPE.channelGrant,
    };

    const saveResult = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'must-not-write',
        decision: 'mirror scope is read-only',
        reasoning: 'member policy has no write authority',
        scopes: [{ kind: 'channel', id: 'trello:team-board' }],
      },
      context
    );
    const deliveryResult = await executor.execute(
      'telegram_send',
      { chat_id: 'member-channel', message: 'must not send' },
      context
    );

    expect(saveResult).toMatchObject({
      success: false,
      error: expect.stringContaining('mama_save is not allowed for role "public_lane"'),
    });
    expect(deliveryResult).toMatchObject({
      success: false,
      error: expect.stringContaining('telegram_send is not allowed for role "public_lane"'),
    });
    expect(api.save).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(channelGrantProvider).not.toHaveBeenCalled();
  });
});
