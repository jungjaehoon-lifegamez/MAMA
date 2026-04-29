import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter } from '../../src/db-manager.js';
import { saveMemoryWithTrustedProvenance } from '../../src/memory/api.js';
import { createTrustedProvenanceCapability } from '../../src/memory/provenance.js';
import {
  getMemoryProvenance,
  listMemoriesByEnvelopeHash,
  listMemoriesByGatewayCallId,
  listMemoriesByModelRunId,
} from '../../src/memory/provenance-query.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';

const TEST_DB = path.join(os.tmpdir(), `test-memory-provenance-query-${randomUUID()}.db`);
const PROJECT_A: MemoryScopeRef = { kind: 'project', id: 'repo:query-a' };
const PROJECT_B: MemoryScopeRef = { kind: 'project', id: 'repo:query-b' };

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

async function saveFixture(topic: string, scope: MemoryScopeRef) {
  return saveMemoryWithTrustedProvenance(
    {
      topic,
      kind: 'decision',
      summary: `Summary for ${topic}`,
      details: `Details for ${topic}`,
      scopes: [scope],
      source: { package: 'mama-core', source_type: 'test', project_id: scope.id },
    },
    {
      capability: createTrustedProvenanceCapability(),
      provenance: {
        actor: 'main_agent',
        envelope_hash: 'env_query',
        gateway_call_id: 'gw_query',
        model_run_id: 'model_query',
        source_refs: [`message:${topic}`],
      },
    }
  );
}

function setCreatedAt(memoryId: string, createdAt: number): void {
  getAdapter()
    .prepare(
      `
        UPDATE decisions
        SET created_at = ?
        WHERE id = ?
      `
    )
    .run(createdAt, memoryId);
}

describe('Story M2.1: Memory Provenance Query Helpers', () => {
  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
  });

  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    delete process.env.MAMA_FORCE_TIER_3;
    cleanupDb();
  });

  describe('AC: indexed provenance lookups return compact lineage', () => {
    it('looks up memories by memory id, envelope hash, gateway call id, and model run id', async () => {
      const saved = await saveFixture('query_helper_contract', PROJECT_A);

      const byId = await getMemoryProvenance(saved.id);
      expect(byId?.source_refs).toEqual(['message:query_helper_contract']);
      expect(byId?.latest_event?.event_type).toBe('save');

      await expect(listMemoriesByEnvelopeHash('env_query')).resolves.toMatchObject([
        { memory_id: saved.id },
      ]);
      await expect(listMemoriesByGatewayCallId('gw_query')).resolves.toMatchObject([
        { memory_id: saved.id },
      ]);
      await expect(listMemoriesByModelRunId('model_query')).resolves.toMatchObject([
        { memory_id: saved.id },
      ]);
    });
  });

  describe('AC: scoped reads use memory_scope_bindings as source of truth', () => {
    it('does not return a different project memory for scoped provenance reads', async () => {
      const projectA = await saveFixture('project_a_memory', PROJECT_A);
      const projectB = await saveFixture('project_b_memory', PROJECT_B);

      const scoped = await listMemoriesByGatewayCallId('gw_query', { scopes: [PROJECT_A] });
      expect(scoped.map((item) => item.memory_id)).toContain(projectA.id);
      expect(scoped.map((item) => item.memory_id)).not.toContain(projectB.id);

      await expect(getMemoryProvenance(projectB.id, { scopes: [PROJECT_A] })).resolves.toBeNull();
    });

    it('treats an empty scopes array as no scope filter', async () => {
      const projectA = await saveFixture('project_a_empty_scope_filter', PROJECT_A);

      await expect(getMemoryProvenance(projectA.id, { scopes: [] })).resolves.toMatchObject({
        memory_id: projectA.id,
      });
      await expect(listMemoriesByGatewayCallId('gw_query', { scopes: [] })).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ memory_id: projectA.id })])
      );
    });

    it('continues paging until it finds the requested number of visible memories', async () => {
      const visibleOne = await saveFixture('project_a_visible_1', PROJECT_A);
      const visibleTwo = await saveFixture('project_a_visible_2', PROJECT_A);
      setCreatedAt(visibleOne.id, 1_000);
      setCreatedAt(visibleTwo.id, 1_001);

      for (let index = 0; index < 10; index += 1) {
        const hidden = await saveFixture(`project_b_hidden_${index}`, PROJECT_B);
        setCreatedAt(hidden.id, 2_000 + index);
      }

      const scoped = await listMemoriesByGatewayCallId('gw_query', {
        scopes: [PROJECT_A],
        limit: 2,
      });

      expect(scoped.map((item) => item.memory_id)).toEqual([visibleTwo.id, visibleOne.id]);
    });
  });
});
