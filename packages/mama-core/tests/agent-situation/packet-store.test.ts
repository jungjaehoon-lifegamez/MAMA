import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import { buildAgentSituationPacketRecord } from '../../src/agent-situation/builder.js';
import {
  acquireAgentSituationLease,
  getFreshAgentSituationPacket,
  getOrRefreshAgentSituationPacket,
  insertAgentSituationPacket,
  releaseAgentSituationLease,
} from '../../src/agent-situation/packet-store.js';
import type {
  AgentSituationEffectiveFilters,
  AgentSituationPacketRecord,
} from '../../src/agent-situation/types.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();

const FILTERS: AgentSituationEffectiveFilters = {
  connectors: ['slack'],
  scopes: [{ kind: 'project', id: 'repo-a' }],
  project_refs: [{ kind: 'project', id: 'repo-a' }],
  tenant_id: 'default',
  as_of: null,
};

function tempDbPath(): string {
  const path = join(os.tmpdir(), `test-agent-situation-store-${randomUUID()}.db`);
  tempPaths.add(path);
  return path;
}

function cleanupDb(path: string): void {
  for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

function createAdapter(): DatabaseAdapter {
  const adapter = new NodeSQLiteAdapter({ dbPath: tempDbPath() }) as unknown as DatabaseAdapter;
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  return adapter;
}

function packet(adapter: DatabaseAdapter, nowMs = 2_000): AgentSituationPacketRecord {
  return buildAgentSituationPacketRecord(adapter, {
    scope: FILTERS.scopes,
    range_start_ms: 1_000,
    range_end_ms: 2_000,
    focus: ['decisions', 'risks'],
    limit: 7,
    effective_filters: FILTERS,
    envelope_hash: 'env-a',
    agent_id: 'agent-a',
    model_run_id: 'mr-a',
    now_ms: nowMs,
  });
}

describe('Story M5: Agent situation packet store', () => {
  afterEach(() => {
    for (const path of tempPaths) {
      cleanupDb(path);
    }
    tempPaths.clear();
  });

  describe('AC #1: packet cache persistence', () => {
    it('inserts packets with provenance fields and reads the newest fresh packet by key', () => {
      const adapter = createAdapter();
      const stale = packet(adapter, 1_000);
      stale.expires_at = 1_500;
      insertAgentSituationPacket(adapter, stale);

      const fresh = packet(adapter, 2_000);
      insertAgentSituationPacket(adapter, fresh);

      const found = getFreshAgentSituationPacket(
        adapter,
        fresh.cache_key,
        fresh.ranking_policy_version,
        2_100
      );

      expect(found).toMatchObject({
        packet_id: fresh.packet_id,
        cache_key: fresh.cache_key,
        agent_id: 'agent-a',
        model_run_id: 'mr-a',
        envelope_hash: 'env-a',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });
      expect(
        getFreshAgentSituationPacket(
          adapter,
          fresh.cache_key,
          fresh.ranking_policy_version,
          200_000
        )
      ).toBeNull();
    });

    it('throws instead of returning fallback fields when stored packet JSON is corrupt', () => {
      const adapter = createAdapter();
      const fresh = insertAgentSituationPacket(adapter, packet(adapter, 2_000));
      adapter
        .prepare('UPDATE agent_situation_packets SET source_coverage_json = ? WHERE packet_id = ?')
        .run('{not-json', fresh.packet_id);

      expect(() =>
        getFreshAgentSituationPacket(adapter, fresh.cache_key, fresh.ranking_policy_version, 2_100)
      ).toThrow(/source_coverage_json/);
    });

    it('rejects invalid packet cache time ranges at the database boundary', () => {
      const adapter = createAdapter();
      const invalidRange = {
        ...packet(adapter, 2_000),
        packet_id: 'situ_invalid_range',
        range_end_ms: 999,
      };
      const invalidExpiry = {
        ...packet(adapter, 2_000),
        packet_id: 'situ_invalid_expiry',
        expires_at: 1_999,
      };
      const invalidTtl = {
        ...packet(adapter, 2_000),
        packet_id: 'situ_invalid_ttl',
        ttl_seconds: 0,
      };

      expect(() => insertAgentSituationPacket(adapter, invalidRange)).toThrow(/constraint/i);
      expect(() => insertAgentSituationPacket(adapter, invalidExpiry)).toThrow(/constraint/i);
      expect(() => insertAgentSituationPacket(adapter, invalidTtl)).toThrow(/constraint/i);
    });

    it('does not call the builder when a fresh cache hit exists', async () => {
      const adapter = createAdapter();
      const existing = insertAgentSituationPacket(adapter, packet(adapter, 2_000));
      let calls = 0;

      const result = await getOrRefreshAgentSituationPacket(
        adapter,
        {
          cacheKey: existing.cache_key,
          rankingPolicyVersion: existing.ranking_policy_version,
          nowMs: 2_100,
          leaseOwner: 'test-owner',
        },
        async () => {
          calls += 1;
          return packet(adapter, 2_100);
        }
      );

      expect(result.packet_id).toBe(existing.packet_id);
      expect(calls).toBe(0);
      expect(
        adapter.prepare('SELECT COUNT(*) AS count FROM agent_situation_packets').get()
      ).toEqual({ count: 1 });
    });
  });

  describe('AC #2: durable lease and in-process singleflight', () => {
    it('allows one live lease per key until release or expiry', () => {
      const adapter = createAdapter();
      const item = packet(adapter, 2_000);

      const lease = acquireAgentSituationLease(adapter, {
        cacheKey: item.cache_key,
        rankingPolicyVersion: item.ranking_policy_version,
        leaseOwner: 'owner-a',
        nowMs: 2_000,
        leaseSeconds: 30,
      });

      expect(lease?.lease_owner).toBe('owner-a');
      expect(
        acquireAgentSituationLease(adapter, {
          cacheKey: item.cache_key,
          rankingPolicyVersion: item.ranking_policy_version,
          leaseOwner: 'owner-b',
          nowMs: 2_100,
          leaseSeconds: 30,
        })
      ).toBeNull();

      releaseAgentSituationLease(adapter, item.cache_key, 'owner-a');
      expect(
        acquireAgentSituationLease(adapter, {
          cacheKey: item.cache_key,
          rankingPolicyVersion: item.ranking_policy_version,
          leaseOwner: 'owner-b',
          nowMs: 2_200,
          leaseSeconds: 30,
        })?.lease_owner
      ).toBe('owner-b');
    });

    it('propagates lease storage failures that are not duplicate live leases', () => {
      const adapter = createAdapter();
      const item = packet(adapter, 2_000);
      adapter
        .prepare(
          `
            CREATE TRIGGER block_agent_situation_lease_insert
            BEFORE INSERT ON agent_situation_refresh_leases
            BEGIN
              SELECT RAISE(ABORT, 'lease storage offline');
            END
          `
        )
        .run();

      expect(() =>
        acquireAgentSituationLease(adapter, {
          cacheKey: item.cache_key,
          rankingPolicyVersion: item.ranking_policy_version,
          leaseOwner: 'owner-a',
          nowMs: 2_000,
          leaseSeconds: 30,
        })
      ).toThrow(/lease storage offline/);
    });

    it('waits for a durable lease winner using the caller logical clock', async () => {
      const adapter = createAdapter();
      const item = packet(adapter, 6_000);
      const lease = acquireAgentSituationLease(adapter, {
        cacheKey: item.cache_key,
        rankingPolicyVersion: item.ranking_policy_version,
        leaseOwner: 'owner-a',
        nowMs: 6_000,
        leaseSeconds: 30,
      });
      insertAgentSituationPacket(adapter, item);

      expect(lease?.lease_owner).toBe('owner-a');
      await expect(
        getOrRefreshAgentSituationPacket(
          adapter,
          {
            cacheKey: item.cache_key,
            rankingPolicyVersion: item.ranking_policy_version,
            nowMs: 6_100,
            leaseOwner: 'owner-b',
            pollIntervalMs: 1,
            maxPollMs: 10,
            refresh: true,
          },
          async () => packet(adapter, 6_100)
        )
      ).resolves.toMatchObject({ packet_id: item.packet_id });
    });

    it('includes the cache key when waiting for a durable lease times out', async () => {
      const adapter = createAdapter();
      const item = packet(adapter, 6_000);
      acquireAgentSituationLease(adapter, {
        cacheKey: item.cache_key,
        rankingPolicyVersion: item.ranking_policy_version,
        leaseOwner: 'owner-a',
        nowMs: 6_000,
        leaseSeconds: 30,
      });

      await expect(
        getOrRefreshAgentSituationPacket(
          adapter,
          {
            cacheKey: item.cache_key,
            rankingPolicyVersion: item.ranking_policy_version,
            nowMs: 6_100,
            leaseOwner: 'owner-b',
            pollIntervalMs: 1,
            maxPollMs: 1,
            refresh: true,
          },
          async () => packet(adapter, 6_100)
        )
      ).rejects.toThrow(item.cache_key);
    });

    it('runs one builder for five concurrent refreshes of the same key', async () => {
      const adapter = createAdapter();
      const sample = packet(adapter, 2_000);
      let calls = 0;

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          getOrRefreshAgentSituationPacket(
            adapter,
            {
              cacheKey: sample.cache_key,
              rankingPolicyVersion: sample.ranking_policy_version,
              nowMs: 2_100,
              leaseOwner: 'owner-singleflight',
            },
            async () => {
              calls += 1;
              return sample;
            }
          )
        )
      );

      expect(calls).toBe(1);
      expect(new Set(results.map((result) => result.packet_id)).size).toBe(1);
      expect(
        adapter.prepare('SELECT COUNT(*) AS count FROM agent_situation_packets').get()
      ).toEqual({ count: 1 });
    });
  });
});
