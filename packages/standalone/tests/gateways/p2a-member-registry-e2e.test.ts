import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { buildGatewayToolCatalog } from '../../src/agent/gateway-tool-catalog.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { RoleManager, resetRoleManager } from '../../src/agent/role-manager.js';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import type { AgentContext, PrincipalRepository } from '../../src/agent/types.js';
import { buildChannelKey } from '../../src/agent/session-pool.js';
import { DEFAULT_CONFIG, DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { backfillTelegramOwner } from '../../src/cli/runtime/owner-backfill.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import { getReactiveRoutePolicy } from '../../src/envelope/reactive-config.js';
import { getMemberCandidateStore } from '../../src/gateways/member-candidate-store.js';
import {
  laneChannelId,
  overlayMemberPrincipal,
  resolveConnectorPrincipal,
  resolveTelegramPrincipal,
  type PrincipalContext,
} from '../../src/gateways/principal.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import StandaloneDatabase from '../../src/sqlite.js';
import { NodeSQLiteAdapter } from '../../../mama-core/src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter as CoreDatabaseAdapter } from '../../../mama-core/src/db-manager.js';
import { createPrincipalRepository } from '../../../mama-core/src/identity/principal-repository.js';
import { applyMigrationsThrough } from '../../../mama-core/src/test-utils.js';

const MEMBER_TOOLS = [
  'member_candidates',
  'member_register',
  'member_suspend',
  'member_offboard',
  'member_list',
] as const;

function agentContext(roleName: 'owner_console' | 'public_lane'): AgentContext {
  const role = DEFAULT_ROLES.definitions[roleName];
  return {
    source: 'telegram',
    platform: 'telegram',
    roleName,
    role,
    session: {
      sessionId: `p2a-${roleName}`,
      startedAt: new Date(0),
    },
    capabilities: [],
    limitations: [],
  };
}

function ownerExecutor(repository: PrincipalRepository): GatewayToolExecutor {
  const executor = new GatewayToolExecutor({
    envelopeIssuanceMode: 'off',
    principalRepository: repository,
  });
  executor.setAgentContext(agentContext('owner_console'));
  return executor;
}

function telegramExternal(userId: string): PrincipalContext {
  return resolveTelegramPrincipal({
    userId,
    chatId: 'p2a-group',
    chatType: 'group',
    allowedChats: new Set(['p2a-group']),
    ownerUserIds: new Set(['p2a-owner']),
  });
}

describe('P2a principal registry completion matrix', () => {
  let adapter: CoreDatabaseAdapter;
  let repository: PrincipalRepository;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-p2a-completion-'));
    const dbPath = join(tempDir, 'core.db');
    const migrationDb = new Database(dbPath);
    migrationDb.pragma('foreign_keys = ON');
    applyMigrationsThrough(migrationDb, 64);
    migrationDb.close();

    adapter = new NodeSQLiteAdapter({ dbPath }) as unknown as CoreDatabaseAdapter;
    adapter.connect();
  });

  beforeEach(() => {
    adapter.prepare('DELETE FROM external_identities').run();
    adapter.prepare('DELETE FROM principals').run();
    repository = createPrincipalRepository(adapter);
    getMemberCandidateStore().clear();
    resetRoleManager();
  });

  afterEach(() => {
    getMemberCandidateStore().clear();
    resetRoleManager();
  });

  afterAll(() => {
    adapter.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('TG-04 Acceptance Criteria: role-bound registry and owner tools', () => {
    it('preserves external lane access and connector identity isolation', () => {
      const externalId = '12345';
      const scenarios = [
        {
          connector: 'telegram',
          namespace: 'global',
          external: telegramExternal(externalId),
          expectedRole: 'public_lane',
        },
        {
          connector: 'slack',
          namespace: 'workspace-p2a',
          external: resolveConnectorPrincipal({
            connector: 'slack',
            namespace: 'workspace-p2a',
            userId: externalId,
            ownerUserId: 'p2a-owner',
            isDirectMessage: false,
          }),
          expectedRole: 'external_data',
        },
        {
          connector: 'discord',
          namespace: 'guild-p2a',
          external: resolveConnectorPrincipal({
            connector: 'discord',
            namespace: 'guild-p2a',
            userId: externalId,
            ownerUserId: 'p2a-owner',
            isDirectMessage: false,
          }),
          expectedRole: 'external_data',
        },
      ] as const;
      const roleManager = new RoleManager();
      const principalIds: string[] = [];

      for (const scenario of scenarios) {
        const principalId = repository.registerMember({
          connector: scenario.connector,
          namespace: scenario.namespace,
          externalId,
          now: 100 + principalIds.length,
        });
        principalIds.push(principalId);

        const row = repository.resolveByExternal(
          scenario.connector,
          scenario.namespace,
          externalId
        );
        const member = overlayMemberPrincipal(scenario.external, row);
        const externalRole = roleManager.getRoleForSource(scenario.connector, {
          principal: scenario.external,
        });
        const memberRole = roleManager.getRoleForSource(scenario.connector, { principal: member });

        expect(member).toMatchObject({
          class: 'member',
          lane: scenario.external.lane,
          principalId,
        });
        expect(memberRole).toEqual(externalRole);
        expect(memberRole.roleName).toBe(scenario.expectedRole);
        expect(memberRole.roleName).not.toBe('chat_bot');
        expect(memberRole.roleName).not.toBe('owner_console');
      }

      expect(new Set(principalIds).size).toBe(3);
    });

    it('TG-04 registers an owner-forwarded candidate and invalidates membership on suspend', async () => {
      // The producer side is exercised through Telegram's real registered callback by:
      // - "TG-04 mints an owner-forwarded candidate from forward_origin instead of message text"
      // - "TG-04 does not mint a candidate from a privacy-hidden forward"
      // in telegram.test.ts. This test continues from that shared host-authenticated store through
      // the real executor, migration-064 repository, ingress overlay, and suspension boundary.
      const candidateStore = getMemberCandidateStore();
      const now = Date.now();
      const candidate = candidateStore.upsert({
        connector: 'telegram',
        namespace: 'global',
        externalId: '24680',
        displayName: 'Forwarded member',
        firstSeen: now,
        expiresAt: now + 60_000,
      });
      const executor = ownerExecutor(repository);

      const registration = await executor.execute('member_register', {
        candidate_id: candidate.candidateId,
      });
      expect(registration).toMatchObject({ success: true, principalId: expect.any(String) });
      expect(candidateStore.get(candidate.candidateId, Date.now())).toBeUndefined();

      const registered = repository.resolveByExternal('telegram', 'global', '24680');
      const external = telegramExternal('24680');
      const member = overlayMemberPrincipal(external, registered);
      expect(member).toMatchObject({ class: 'member', lane: 'public' });

      await expect(
        executor.execute('member_suspend', { principal_id: member.principalId })
      ).resolves.toMatchObject({ success: true, status: 'suspended' });

      const suspended = repository.resolveByExternal('telegram', 'global', '24680');
      expect(suspended).toMatchObject({ kind: 'member', status: 'suspended' });
      expect(overlayMemberPrincipal(external, suspended)).toBe(external);
      expect(overlayMemberPrincipal(external, suspended).class).toBe('external');
    });

    it('TG-04 keeps owner backfill bookkeeping-only, idempotent, singular, and fail-closed', () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const ownerId = 'p2a-owner-bookkeeping';
      const telegram = { owner_user_ids: [ownerId], allowed_chats: [ownerId] };

      expect(backfillTelegramOwner({ telegram, registry: repository, now: 200, logger })).toBe(
        'created'
      );
      expect(backfillTelegramOwner({ telegram, registry: repository, now: 201, logger })).toBe(
        'exists'
      );

      const ownerRow = repository.resolveByExternal('telegram', 'global', ownerId);
      const ingressWithExplicitlyEmptyOwners = resolveTelegramPrincipal({
        userId: ownerId,
        chatId: ownerId,
        chatType: 'private',
        allowedChats: new Set([ownerId]),
        ownerUserIds: new Set(),
      });
      expect(ownerRow).toMatchObject({ kind: 'owner', status: 'active' });
      expect(overlayMemberPrincipal(ingressWithExplicitlyEmptyOwners, ownerRow)).toEqual({
        class: 'external',
        lane: 'divert',
        canonicalId: `telegram:global:${ownerId}`,
        consoleEligible: false,
      });

      expect(
        repository.ensureOwner({
          connector: 'slack',
          namespace: 'workspace-p2a',
          externalId: 'second-owner',
          now: 202,
        })
      ).toBe('conflict');
      expect(repository.resolveByExternal('slack', 'workspace-p2a', 'second-owner')).toBeNull();

      const countBeforeSkips = adapter.prepare('SELECT COUNT(*) AS count FROM principals').get();
      expect(backfillTelegramOwner({ telegram: {}, registry: repository, now: 203, logger })).toBe(
        'skipped'
      );
      expect(
        backfillTelegramOwner({
          telegram: { allowed_chats: ['1001', '1002'] },
          registry: repository,
          now: 204,
          logger,
        })
      ).toBe('skipped');
      expect(adapter.prepare('SELECT COUNT(*) AS count FROM principals').get()).toEqual(
        countBeforeSkips
      );
      expect(logger.info).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('TG-04 projects all five member tools and refuses them for a non-owner executor role', async () => {
      const disabledPrivatePolicy = resolvePrivateConnectorPolicy({
        ok: true,
        config: {},
        enabledNames: [],
      });
      const ownerRole = DEFAULT_ROLES.definitions.owner_console;
      const nativeCatalog = buildGatewayToolCatalog({
        surface: 'owner_console',
        allowedTools: ownerRole.allowedTools,
        blockedTools: ownerRole.blockedTools,
        privateConnectorPolicy: disabledPrivatePolicy,
      });
      const executor = ownerExecutor(repository);
      const codeActNames = new HostBridge(executor)
        .getAvailableFunctions(2)
        .map((tool) => tool.name);

      expect(ToolRegistry.getValidToolNames()).toEqual(expect.arrayContaining([...MEMBER_TOOLS]));
      expect(nativeCatalog.toolNames).toEqual(expect.arrayContaining([...MEMBER_TOOLS]));
      expect(codeActNames).toEqual(expect.arrayContaining([...MEMBER_TOOLS]));

      executor.setAgentContext(agentContext('public_lane'));
      for (const toolName of MEMBER_TOOLS) {
        const input =
          toolName === 'member_register'
            ? { candidate_id: 'candidate-refused' }
            : toolName === 'member_suspend' || toolName === 'member_offboard'
              ? { principal_id: 'principal-refused' }
              : {};
        await expect(executor.execute(toolName, input)).resolves.toMatchObject({
          success: false,
          error: expect.stringContaining('owner_console'),
        });
      }
    });

    it('TG-04 refuses model-supplied identities without a host candidate', async () => {
      const executor = ownerExecutor(repository);

      const result = await executor.execute('member_register', {
        connector: 'telegram',
        external_id: 'model-supplied-id',
        username: 'synthetic_handle',
      });

      expect(result).toMatchObject({
        success: false,
        code: 'member_candidate_required',
        error: expect.stringContaining('candidate_id'),
      });
      expect(repository.listMembers()).toEqual([]);
    });

    it('TG-04 denies owner-console envelope access to a member with forced console eligibility', () => {
      const member: PrincipalContext = {
        class: 'member',
        lane: 'public',
        canonicalId: 'telegram:global:p2a-member',
        principalId: 'principal-p2a-member',
        consoleEligible: true,
      };
      const message: NormalizedMessage = {
        source: 'telegram',
        channelId: 'p2a-member',
        userId: 'p2a-member',
        text: 'synthetic member turn',
        principal: member,
        metadata: { chatType: 'private' },
      };
      const config = {
        ...DEFAULT_CONFIG,
        roles: DEFAULT_ROLES,
        telegram: {
          ...DEFAULT_CONFIG.telegram,
          allowed_chats: ['p2a-member'],
          owner_user_ids: ['p2a-owner'],
        },
      };

      expect(new RoleManager().getRoleForSource('telegram', { principal: member }).roleName).toBe(
        'public_lane'
      );
      expect(
        getReactiveRoutePolicy(message, config, { HOME: '/tmp/p2a-home' }, [
          'kagemusha',
          'trello',
          'drive',
        ]).rawConnectors
      ).toEqual(['telegram']);
    });
  });

  describe('TG-05 Acceptance Criteria: principal-independent session continuity', () => {
    it('keeps the session key stable when only member principalId changes', () => {
      const channelId = 'p2a-session-channel';
      const userId = 'p2a-session-user';
      const external = resolveTelegramPrincipal({
        userId,
        chatId: channelId,
        chatType: 'group',
        allowedChats: new Set([channelId]),
        ownerUserIds: new Set(['p2a-owner']),
      });
      const principalId = repository.registerMember({
        connector: 'telegram',
        namespace: 'global',
        externalId: userId,
        now: 300,
      });
      const member = overlayMemberPrincipal(
        external,
        repository.resolveByExternal('telegram', 'global', userId)
      );
      const externalChannelKey = laneChannelId(channelId, external.lane);
      const memberChannelKey = laneChannelId(channelId, member.lane);

      expect(member).toMatchObject({ class: 'member', principalId });
      expect(buildChannelKey('telegram', memberChannelKey)).toBe(
        buildChannelKey('telegram', externalChannelKey)
      );

      // This is the exact MessageRouter -> SessionStore key formula: source plus lane-adjusted
      // channel. Neither layer accepts principalId as part of the durable key.
      const sessionStore = new SessionStore(new StandaloneDatabase(':memory:'));
      try {
        const externalSession = sessionStore.getOrCreate('telegram', externalChannelKey, userId);
        const memberSession = sessionStore.getOrCreate('telegram', memberChannelKey, userId);
        expect(memberSession.id).toBe(externalSession.id);
        expect(memberSession.channelId).toBe(`${channelId}#public`);
      } finally {
        sessionStore.close();
      }
    });
  });

  // Completion-matrix cell 9 is documentation-only by design. Migration 064 adds isolated
  // principals/external_identities tables; rollback code has no readers or writers for them and
  // therefore ignores them. The Internal changelog entry records that compatibility contract.
});
