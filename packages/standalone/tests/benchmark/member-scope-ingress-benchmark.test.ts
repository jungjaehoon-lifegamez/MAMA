import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { mama } from '@jungjaehoon/mama-core';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createRuntimeMemberScopeResolver,
  createRuntimeMessageRouter,
} from '../../src/cli/commands/start.js';
import { resolveMemberEffectiveScope } from '../../src/gateways/member-effective-scope.js';
import type { MamaApiClient } from '../../src/gateways/context-injector.js';
import { resolveConnectorPrincipal } from '../../src/gateways/principal.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import StandaloneDatabase from '../../src/sqlite.js';
import { makeAuthorityHarness } from '../envelope/fixtures.js';
import { NodeSQLiteAdapter } from '../../../mama-core/src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../../mama-core/src/db-manager.js';
import {
  createPrincipalRepository,
  type PrincipalRepository,
} from '../../../mama-core/src/identity/principal-repository.js';
import { applyMigrationsThrough } from '../../../mama-core/src/test-utils.js';

const WARMUP_SAMPLES = 250;
const MEASURED_SAMPLES = 2_000;
const P95_ADDED_LATENCY_BUDGET_MS = 10;

const realMamaApiClient: MamaApiClient = {
  async search(query, limit) {
    const result = await mama.suggest(query, limit === undefined ? undefined : { limit });
    return (result?.results ?? []) as Awaited<ReturnType<MamaApiClient['search']>>;
  },
};

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function summary(samples: readonly number[]): { medianMs: number; p95Ms: number } {
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

describe('Phase 2b member ingress benchmark', () => {
  let adapter: DatabaseAdapter;
  let repository: PrincipalRepository;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-member-ingress-benchmark-'));
    const dbPath = join(tempDir, 'principals.db');
    const migrationDb = new Database(dbPath);
    migrationDb.pragma('foreign_keys = ON');
    applyMigrationsThrough(migrationDb, 65);
    migrationDb.close();
    adapter = new NodeSQLiteAdapter({ dbPath }) as unknown as DatabaseAdapter;
    adapter.connect();
    repository = createPrincipalRepository(adapter);
  });

  afterAll(() => {
    adapter.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports warmed real-SQLite added latency under budget with one member query and zero owner/external queries', async () => {
    repository.ensureOwner({
      connector: 'telegram',
      namespace: 'global',
      externalId: 'benchmark-owner',
      now: 1,
    });
    const memberPrincipalId = repository.registerMember({
      connector: 'telegram',
      namespace: 'global',
      externalId: 'benchmark-member',
      now: 2,
    });
    const ownerPrincipalId = repository.resolveByExternal(
      'telegram',
      'global',
      'benchmark-owner'
    )!.principalId;
    repository.grantScope({
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope: { kind: 'source', connector: 'board', channelId: 'shared' },
      now: 3,
    });
    repository.grantScope({
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: 'team' },
      now: 4,
    });

    const principal = {
      class: 'member' as const,
      lane: 'public' as const,
      canonicalId: 'telegram:global:benchmark-member',
      principalId: memberPrincipalId,
      consoleEligible: false,
    };
    const current = {
      connector: 'telegram',
      lane: 'public' as const,
      channelId: 'member-chat',
    };
    const configuredGrant = { board: ['shared', 'sibling'] };
    const activeGrants = repository.listActiveGrants(memberPrincipalId);
    const resolvePure = () =>
      resolveMemberEffectiveScope({
        principal,
        current,
        configuredGrant,
        principalGrants: activeGrants,
      });
    let grantQueries = 0;
    const resolveIngress = createRuntimeMemberScopeResolver(
      {
        listActiveGrants(principalId) {
          grantQueries += 1;
          return repository.listActiveGrants(principalId);
        },
      },
      () => configuredGrant
    );

    for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
      resolvePure();
      resolveIngress({ principal, current });
    }
    grantQueries = 0;

    const pureSamples: number[] = [];
    const ingressSamples: number[] = [];
    const addedSamples: number[] = [];
    for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
      const pureStartedAt = performance.now();
      const pure = resolvePure();
      const pureElapsed = performance.now() - pureStartedAt;

      const ingressStartedAt = performance.now();
      const ingress = resolveIngress({ principal, current });
      const ingressElapsed = performance.now() - ingressStartedAt;

      expect(ingress.fingerprint).toBe(pure.fingerprint);
      pureSamples.push(pureElapsed);
      ingressSamples.push(ingressElapsed);
      addedSamples.push(Math.max(0, ingressElapsed - pureElapsed));
    }
    expect(grantQueries).toBe(MEASURED_SAMPLES);

    const sessionDb = new StandaloneDatabase(':memory:');
    const sessionStore = new SessionStore(sessionDb);
    const { authority } = makeAuthorityHarness(sessionDb);
    const modelRuns = vi.fn().mockResolvedValue({ response: 'benchmark response' });
    const router = createRuntimeMessageRouter({
      sessionStore,
      agentLoopClient: { childRuntimeToolCapable: false, run: modelRuns },
      mamaApiClient: realMamaApiClient,
      config: { backend: 'codex', implicitLegacyContextSearch: false },
      envelopeConfig: {
        projectRefsFor: () => [],
        rawConnectorsFor: () => [],
        memoryScopesFor: () => [],
        allowedDestinationsFor: (message) => [{ kind: message.source, id: message.channelId }],
        reactiveBudgetSeconds: 30,
      },
      envelopeAuthority: authority,
      memberGrantReader: {
        listActiveGrants(principalId) {
          grantQueries += 1;
          return repository.listActiveGrants(principalId);
        },
      },
      configuredGrant: () => configuredGrant,
    });
    const queryCountBeforeNonMembers = grantQueries;
    try {
      await router.process({
        source: 'slack',
        channelId: 'owner-chat',
        userId: 'owner',
        text: 'owner operation',
        principal: resolveConnectorPrincipal({
          connector: 'slack',
          namespace: 'team',
          userId: 'owner',
          ownerUserId: 'owner',
          isDirectMessage: true,
        }),
        metadata: { messageId: 'owner-benchmark' },
      });
      await router.process({
        source: 'slack',
        channelId: 'external-chat',
        userId: 'external',
        text: 'external operation',
        principal: resolveConnectorPrincipal({
          connector: 'slack',
          namespace: 'team',
          userId: 'external',
          ownerUserId: 'owner',
          isDirectMessage: false,
        }),
        metadata: { messageId: 'external-benchmark' },
      });
      expect(grantQueries).toBe(queryCountBeforeNonMembers);
    } finally {
      sessionStore.close();
    }

    const pureSummary = summary(pureSamples);
    const ingressSummary = summary(ingressSamples);
    const addedSummary = summary(addedSamples);
    console.info(
      '[Phase 2b ingress benchmark]',
      JSON.stringify({
        samples: MEASURED_SAMPLES,
        pureResolver: pureSummary,
        repositoryAndResolver: ingressSummary,
        addedLatency: addedSummary,
        memberGrantQueries: MEASURED_SAMPLES,
        ownerGrantQueries: 0,
        externalGrantQueries: 0,
      })
    );
    expect(addedSummary.p95Ms).toBeLessThan(P95_ADDED_LATENCY_BUDGET_MS);
  });
});
