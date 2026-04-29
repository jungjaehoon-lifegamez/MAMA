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
  getOrRefreshAgentSituationPacket,
} from '../../src/agent-situation/packet-store.js';
import type { AgentSituationEffectiveFilters } from '../../src/agent-situation/types.js';

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
  const path = join(os.tmpdir(), `test-agent-situation-singleflight-${randomUUID()}.db`);
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

function packet(adapter: DatabaseAdapter, nowMs = 2_000) {
  return buildAgentSituationPacketRecord(adapter, {
    scope: FILTERS.scopes,
    range_start_ms: 1_000,
    range_end_ms: 2_000,
    focus: ['decisions'],
    limit: 7,
    effective_filters: FILTERS,
    envelope_hash: 'env-a',
    agent_id: 'agent-a',
    model_run_id: 'mr-a',
    now_ms: nowMs,
  });
}

describe('Story M5: Agent situation refresh singleflight', () => {
  afterEach(() => {
    for (const path of tempPaths) {
      cleanupDb(path);
    }
    tempPaths.clear();
  });

  describe('AC #1: expired leases do not block refresh', () => {
    it('cleans expired leases before acquire and refresh', async () => {
      const adapter = createAdapter();
      const sample = packet(adapter, 2_000);
      acquireAgentSituationLease(adapter, {
        cacheKey: sample.cache_key,
        rankingPolicyVersion: sample.ranking_policy_version,
        leaseOwner: 'expired-owner',
        nowMs: 1_000,
        leaseSeconds: 1,
      });
      let calls = 0;

      const result = await getOrRefreshAgentSituationPacket(
        adapter,
        {
          cacheKey: sample.cache_key,
          rankingPolicyVersion: sample.ranking_policy_version,
          nowMs: 3_000,
          leaseOwner: 'fresh-owner',
        },
        async () => {
          calls += 1;
          return sample;
        }
      );

      expect(calls).toBe(1);
      expect(result.packet_id).toBe(sample.packet_id);
    });
  });
});
