import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter } from '../../src/db-manager.js';
import { queryRelevantTruth, saveMemory } from '../../src/index.js';

const TEST_DB = path.join(os.tmpdir(), `test-truth-projection-sync-${randomUUID()}.db`);
const PROJECT_SCOPE = { kind: 'project' as const, id: 'repo:truth-projection-sync' };
const OTHER_SCOPE = { kind: 'project' as const, id: 'repo:truth-projection-other' };

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

function insertContradictoryTruthRow(input: {
  memoryId: string;
  topic: string;
  scopeRefs: Array<{ kind: 'project'; id: string }>;
  truthStatus: 'active' | 'superseded';
}): void {
  const now = Date.now();
  getAdapter()
    .prepare(
      `
        INSERT OR REPLACE INTO memory_truth (
          memory_id, topic, truth_status, effective_summary, effective_details, trust_score,
          scope_refs, supporting_event_ids, superseded_by, contradicted_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?, ?)
      `
    )
    .run(
      input.memoryId,
      input.topic,
      input.truthStatus,
      `Stale projection for ${input.memoryId}`,
      'This row must not affect current-memory reads.',
      1,
      JSON.stringify(input.scopeRefs),
      now,
      now
    );
}

describe('Task 1: decisions.status is the only current memory authority', () => {
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

  it('reads current and historical rows from decisions and matching bindings, not memory_truth', async () => {
    const superseded = await saveMemory({
      topic: 'authority_boundary',
      kind: 'decision',
      summary: 'Use the superseded decision',
      details: 'Historical decision details',
      confidence: 0.4,
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });
    const active = await saveMemory({
      topic: 'authority_boundary',
      kind: 'decision',
      summary: 'Use the active decision',
      details: 'Current decision details',
      confidence: 0.9,
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });
    const otherScope = await saveMemory({
      topic: 'other_scope_authority',
      kind: 'decision',
      summary: 'Keep this decision in the other scope',
      details: 'It has no matching project binding.',
      confidence: 0.8,
      scopes: [OTHER_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: OTHER_SCOPE.id },
    });

    insertContradictoryTruthRow({
      memoryId: superseded.id,
      topic: 'authority_boundary',
      scopeRefs: [PROJECT_SCOPE],
      truthStatus: 'active',
    });
    insertContradictoryTruthRow({
      memoryId: active.id,
      topic: 'authority_boundary',
      scopeRefs: [PROJECT_SCOPE],
      truthStatus: 'superseded',
    });
    insertContradictoryTruthRow({
      memoryId: otherScope.id,
      topic: 'other_scope_authority',
      scopeRefs: [PROJECT_SCOPE],
      truthStatus: 'active',
    });

    const current = await queryRelevantTruth({
      query: '',
      scopes: [PROJECT_SCOPE],
      includeHistory: false,
    });
    expect(current.map((row) => row.memory_id)).toEqual([active.id]);
    expect(current[0]).toMatchObject({
      truth_status: 'active',
      effective_summary: 'Use the active decision',
      effective_details: 'Current decision details',
    });

    const history = await queryRelevantTruth({
      query: '',
      scopes: [PROJECT_SCOPE],
      includeHistory: true,
    });
    expect(history.map((row) => row.memory_id)).toEqual([active.id, superseded.id]);
    expect(history.map((row) => row.truth_status)).toEqual(['active', 'superseded']);
  });

  it('fails closed when no scopes are authorized', async () => {
    await saveMemory({
      topic: 'empty_scope_authority',
      kind: 'decision',
      summary: 'This active decision requires its project scope',
      details: 'An unscoped caller must not receive it.',
      confidence: 0.9,
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });

    const current = await queryRelevantTruth({
      query: '',
      scopes: [],
      includeHistory: false,
    });

    expect(current).toEqual([]);
  });
});
