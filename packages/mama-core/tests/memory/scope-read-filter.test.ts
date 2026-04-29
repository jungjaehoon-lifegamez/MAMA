import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import { saveMemoryWithTrustedProvenance } from '../../src/memory/api.js';
import { createTrustedProvenanceCapability } from '../../src/memory/provenance.js';
import {
  getMemoryProvenance,
  listMemoriesByGatewayCallId,
} from '../../src/memory/provenance-query.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';

const TEST_DB = path.join(os.tmpdir(), `test-scope-read-filter-${randomUUID()}.db`);
const PROJECT_A: MemoryScopeRef = { kind: 'project', id: 'repo:scope-a' };
const PROJECT_B: MemoryScopeRef = { kind: 'project', id: 'repo:scope-b' };

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

async function saveScoped(topic: string, scope: MemoryScopeRef) {
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
        gateway_call_id: 'gw_scope_filter',
        source_refs: [`message:${topic}`],
      },
    }
  );
}

function insertLegacyUnscoped(memoryId: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, user_involvement, status, created_at,
          updated_at, gateway_call_id, source_refs_json, provenance_json
        )
        VALUES (
          ?, 'legacy/unscoped', 'legacy memory', 'seeded', 0.8, 'approved', 'active', ?, ?,
          'gw_scope_filter', '[]', '{"actor":"actor:legacy","source_type":"legacy"}'
        )
      `
    )
    .run(memoryId, Date.parse('2026-04-29T04:00:00.000Z'), Date.parse('2026-04-29T04:00:00.000Z'));
}

describe('Story M2.3: Scope-aware provenance read filters', () => {
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

  describe('Acceptance Criteria', () => {
    describe('AC #1: scoped reads only return memories bound to requested scopes', () => {
      it('does not return project B memory when reading with project A scope', async () => {
        const projectA = await saveScoped('project-a-memory', PROJECT_A);
        const projectB = await saveScoped('project-b-memory', PROJECT_B);

        const scoped = await listMemoriesByGatewayCallId('gw_scope_filter', {
          scopes: [PROJECT_A],
        });

        expect(scoped.map((memory) => memory.memory_id)).toContain(projectA.id);
        expect(scoped.map((memory) => memory.memory_id)).not.toContain(projectB.id);
        await expect(getMemoryProvenance(projectB.id, { scopes: [PROJECT_A] })).resolves.toBeNull();
      });
    });

    describe('AC #2: legacy unscoped rows require explicit opt-in', () => {
      it('hides unscoped legacy rows from scoped reads unless includeLegacyUnscoped is true', async () => {
        await initDB();
        insertLegacyUnscoped('mem-legacy-unscoped');

        await expect(
          getMemoryProvenance('mem-legacy-unscoped', { scopes: [PROJECT_A] })
        ).resolves.toBeNull();
        await expect(
          listMemoriesByGatewayCallId('gw_scope_filter', { scopes: [PROJECT_A] })
        ).resolves.toEqual([]);

        await expect(
          getMemoryProvenance('mem-legacy-unscoped', {
            scopes: [PROJECT_A],
            includeLegacyUnscoped: true,
          })
        ).resolves.toMatchObject({ memory_id: 'mem-legacy-unscoped' });
        await expect(
          listMemoriesByGatewayCallId('gw_scope_filter', {
            scopes: [PROJECT_A],
            includeLegacyUnscoped: true,
          })
        ).resolves.toEqual([expect.objectContaining({ memory_id: 'mem-legacy-unscoped' })]);
      });
    });
  });
});
