import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/embeddings.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/embeddings.js')>('../../src/embeddings.js');
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
  };
});

vi.mock('../../src/db-manager.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/db-manager.js')>('../../src/db-manager.js');
  return {
    ...actual,
    vectorSearch: vi.fn(),
  };
});

import { closeDB, getAdapter, vectorSearch } from '../../src/db-manager.js';
import {
  promoteMemoryStatus,
  saveMemory,
  saveMemoryWithTrustedProvenance,
} from '../../src/memory/api.js';
import { createTrustedProvenanceCapability } from '../../src/memory/provenance.js';

const TEST_DB = path.join(os.tmpdir(), `test-memory-promotion-semantic-${randomUUID()}.db`);
const PROJECT_SCOPE = { kind: 'project' as const, id: 'repo:promotion-semantic' };

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

describe('Story M2.1: staged memory promotion semantic evolution', () => {
  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
    vi.mocked(vectorSearch).mockReset();
    vi.mocked(vectorSearch).mockResolvedValue([]);
  });

  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    delete process.env.MAMA_FORCE_TIER_3;
    cleanupDb();
  });

  it('uses semantic candidates when promoting a staged memory to active', async () => {
    const oldMemory = await saveMemory({
      topic: 'sqlite_memory_store',
      kind: 'decision',
      summary: 'Use SQLite for the memory store',
      details: 'Existing operator decision',
      confidence: 0.8,
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });
    const stagedMemory = await saveMemoryWithTrustedProvenance(
      {
        topic: 'reviewed_manual_memory_store',
        kind: 'decision',
        summary: 'Use SQLite for the memory store with reviewed provenance',
        details: 'Manual operator review approved the replacement memory.',
        confidence: 0.9,
        status: 'stale',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
      },
      {
        capability: createTrustedProvenanceCapability(),
        projectTruth: false,
        provenance: {
          actor: 'user',
          agent_id: 'operator:manual-admin',
          tool_name: 'mama_save',
          gateway_call_id: 'manual-promotion-semantic:memory:0',
          source_refs: ['raw:slack:manual-promotion-semantic'],
        },
      }
    );

    vi.mocked(vectorSearch).mockResolvedValueOnce([
      {
        id: oldMemory.id,
        topic: 'sqlite_memory_store',
        decision: 'Use SQLite for the memory store',
        status: 'active',
      } as never,
    ]);

    await promoteMemoryStatus({ memoryId: stagedMemory.id, status: 'active' });

    expect(
      getAdapter()
        .prepare('SELECT status, superseded_by FROM decisions WHERE id = ?')
        .get(oldMemory.id)
    ).toEqual({ status: 'active', superseded_by: null });
    expect(
      getAdapter()
        .prepare('SELECT status, supersedes FROM decisions WHERE id = ?')
        .get(stagedMemory.id)
    ).toEqual({ status: 'active', supersedes: null });
    expect(
      getAdapter()
        .prepare('SELECT relationship FROM decision_edges WHERE from_id = ? AND to_id = ?')
        .get(stagedMemory.id, oldMemory.id)
    ).toEqual({ relationship: 'builds_on' });
  });
});
