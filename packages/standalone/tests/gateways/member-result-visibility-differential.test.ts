import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeDB,
  createEdge,
  createTrustedProvenanceCapability,
  getAdapter,
  initDB,
  mama,
  saveMemoryWithTrustedProvenance,
  upsertConnectorEventIndex,
} from '@jungjaehoon/mama-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContextCompileService } from '../../src/agent/context-compile-service.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolExecutionContext, MAMAApiInterface } from '../../src/agent/types.js';
import { resolveMemberEffectiveScope } from '../../src/gateways/member-effective-scope.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

describe('Phase 2b member result visibility differential', () => {
  let testDir: string;
  let originalDbPath: string | undefined;
  let originalForceTier3: string | undefined;

  beforeEach(async () => {
    originalDbPath = process.env.MAMA_DB_PATH;
    originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
    testDir = mkdtempSync(join(tmpdir(), 'mama-member-result-visibility-'));
    await closeDB();
    process.env.MAMA_DB_PATH = join(testDir, 'memory.db');
    process.env.MAMA_FORCE_TIER_3 = 'true';
    await initDB();
  });

  afterEach(async () => {
    await closeDB();
    if (originalDbPath === undefined) {
      delete process.env.MAMA_DB_PATH;
    } else {
      process.env.MAMA_DB_PATH = originalDbPath;
    }
    if (originalForceTier3 === undefined) {
      delete process.env.MAMA_FORCE_TIER_3;
    } else {
      process.env.MAMA_FORCE_TIER_3 = originalForceTier3;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('re-authorizes real memory, raw, graph, and provenance results under one detached snapshot', async () => {
    const principalId = 'principal-member-differential';
    const projectId = 'project-member-visible';
    const hiddenProjectId = 'project-owner-hidden';
    const visibleRawMarker = 'MEMBER_VISIBLE_RAW_RESULT';
    const hiddenRawMarker = 'OWNER_HIDDEN_RAW_RESULT';
    const visibleMemoryMarker = 'MEMBER_VISIBLE_MEMORY_RESULT';
    const hiddenMemoryMarker = 'OWNER_HIDDEN_MEMORY_RESULT';
    const snapshot = resolveMemberEffectiveScope({
      principal: {
        class: 'member',
        lane: 'public',
        canonicalId: 'telegram:global:member-differential',
        principalId,
        consoleEligible: false,
      },
      current: { connector: 'telegram', lane: 'public', channelId: 'member-chat' },
      configuredGrant: { board: ['member-board', 'owner-board'] },
      principalGrants: [
        {
          targetPrincipalId: principalId,
          scope: { kind: 'source', connector: 'board', channelId: 'member-board' },
          grantedByPrincipalId: 'principal-owner',
          createdAt: 1,
        },
        {
          targetPrincipalId: principalId,
          scope: { kind: 'memory', scopeKind: 'project', scopeId: projectId },
          grantedByPrincipalId: 'principal-owner',
          createdAt: 2,
        },
      ],
    });

    const adapter = getAdapter();
    const now = Date.now();
    const visibleEvent = upsertConnectorEventIndex(adapter, {
      source_connector: 'board',
      source_type: 'message',
      source_id: 'member-visible-event',
      channel: 'member-board',
      content: `member differential ${visibleRawMarker}`,
      source_timestamp_ms: now,
      tenant_id: 'default',
      project_id: projectId,
      memory_scope_kind: 'project',
      memory_scope_id: projectId,
    });
    const hiddenEvent = upsertConnectorEventIndex(adapter, {
      source_connector: 'board',
      source_type: 'message',
      source_id: 'owner-hidden-event',
      channel: 'owner-board',
      content: `member differential ${hiddenRawMarker}`,
      source_timestamp_ms: now + 1,
      tenant_id: 'default',
      project_id: projectId,
      memory_scope_kind: 'project',
      memory_scope_id: projectId,
    });
    const visibleMemory = await saveMemoryWithTrustedProvenance(
      {
        topic: 'member_differential_visible',
        kind: 'decision',
        summary: `member differential ${visibleMemoryMarker}`,
        details: visibleMemoryMarker,
        scopes: [{ kind: 'project', id: projectId }],
        source: { package: 'standalone', source_type: 'test', project_id: projectId },
      },
      {
        capability: createTrustedProvenanceCapability(),
        provenance: {
          actor: 'main_agent',
          source_refs: [
            `raw:board:${visibleEvent.event_index_id}`,
            `raw:board:${hiddenEvent.event_index_id}`,
          ],
        },
      }
    );
    const hiddenMemory = await saveMemoryWithTrustedProvenance(
      {
        topic: 'member_differential_hidden',
        kind: 'decision',
        summary: `member differential ${hiddenMemoryMarker}`,
        details: hiddenMemoryMarker,
        scopes: [{ kind: 'project', id: hiddenProjectId }],
        source: {
          package: 'standalone',
          source_type: 'test',
          project_id: hiddenProjectId,
        },
      },
      {
        capability: createTrustedProvenanceCapability(),
        provenance: { actor: 'main_agent', source_refs: [] },
      }
    );
    await createEdge(visibleMemory.id, hiddenMemory.id, 'refines', 'cross-scope hidden edge');

    const channelGrantProvider = vi.fn(() => ({ board: ['owner-board'] }));
    const realContextService = createContextCompileService({
      memoryAdapter: adapter,
      channelGrant: channelGrantProvider,
    });
    const observedSnapshots: unknown[] = [];
    const contextCompileService = {
      async compileAndPersistContext(
        request: Parameters<typeof realContextService.compileAndPersistContext>[0]
      ) {
        observedSnapshots.push(request.channelGrantSnapshot);
        return realContextService.compileAndPersistContext(request);
      },
    };
    const executor = new GatewayToolExecutor({
      mamaApi: mama as unknown as MAMAApiInterface,
      channelGrantProvider,
      contextCompileService,
      envelopeIssuanceMode: 'enabled',
    });
    const context: GatewayToolExecutionContext = {
      agentId: 'member',
      source: 'telegram',
      channelId: 'member-chat',
      agentContext: {
        source: 'telegram',
        platform: 'telegram',
        roleName: 'public_lane',
        role: {
          model: 'gpt-5.4',
          maxTurns: 4,
          allowedTools: [
            'mama_search',
            'mama_recall',
            'mama_provenance',
            'context_compile',
            'code_act',
          ],
          allowedPaths: [],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: { sessionId: 'member-differential', startedAt: new Date() },
        capabilities: [],
        limitations: [],
        tier: 2,
        backend: 'codex',
      },
      envelope: makeSignedEnvelope({
        source: 'telegram',
        channel_id: 'member-chat',
        tier: 2,
        scope: {
          project_refs: [{ kind: 'project', id: projectId }],
          raw_connectors: ['telegram', 'board'],
          memory_scopes: snapshot.memoryScopes.map((scope) => ({ ...scope })),
          allowed_destinations: [{ kind: 'telegram', id: 'member-chat' }],
        },
      }),
      executionSurface: 'model_tool',
      channelGrantSnapshot: snapshot.channelGrant,
      memberScopeRequired: true,
    };

    const recall = await executor.execute('mama_recall', { query: 'member differential' }, context);
    const compiled = await executor.execute(
      'context_compile',
      { task: 'member differential', connectors: ['board'], limit: 20 },
      context
    );
    const provenance = await executor.execute(
      'mama_provenance',
      { memory_id: visibleMemory.id },
      context
    );

    const recallJson = JSON.stringify(recall);
    const compiledJson = JSON.stringify(compiled);
    const provenanceJson = JSON.stringify(provenance);
    expect(recallJson).toContain(visibleMemoryMarker);
    expect(recallJson).not.toContain(hiddenMemoryMarker);
    expect(recallJson).not.toContain(hiddenMemory.id);
    expect(compiledJson).toContain(visibleRawMarker);
    expect(compiledJson).not.toContain(hiddenRawMarker);
    expect(provenanceJson).toContain(visibleRawMarker);
    expect(provenanceJson).not.toContain(hiddenRawMarker);
    expect(observedSnapshots).toEqual([snapshot.channelGrant]);
    expect(observedSnapshots[0]).toBe(snapshot.channelGrant);
    expect(channelGrantProvider).not.toHaveBeenCalled();
  });
});
