/**
 * Regression: recallMemory must honor options.limit on the returned memories.
 *
 * Live incident (2026-07-09): the operator trigger loop requested limit 5 and received
 * 257 memories per recall - requestedLimit (api.ts:1159) was only applied to wiki
 * candidate fetches, never to the final `bundle.memories` (api.ts:1939), which also
 * drove per-record SQL enrichment loops over the full unlimited set.
 *
 * Real DB (tmp MAMA_DB_PATH) + MAMA_FORCE_TIER_3 lexical path - no mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'recall-limit-'));
process.env.MAMA_DB_PATH = join(tmpDir, 'test-memory.db');
process.env.MAMA_FORCE_TIER_3 = 'true';

import { initDB, closeDB } from '../../src/db-manager.js';
import { saveMemory, recallMemory } from '../../src/memory/api.js';

describe('recallMemory limit', () => {
  beforeAll(async () => {
    await initDB();
    for (let i = 0; i < 12; i++) {
      await saveMemory({
        topic: `deploy-note-${i}`,
        kind: 'decision',
        summary: `Deployment rollout note ${i} about the canary pipeline`,
        details: `Deployment rollout detail ${i} about the canary pipeline stage`,
        scopes: [{ kind: 'global', id: 'global' }],
        source: { package: 'mama-core', source_type: 'test' },
      });
    }
  }, 30000);

  afterAll(async () => {
    await closeDB();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns at most options.limit memories', async () => {
    const bundle = await recallMemory('deployment rollout canary pipeline', { limit: 3 });
    expect(bundle.memories.length).toBeGreaterThan(0);
    expect(bundle.memories.length).toBeLessThanOrEqual(3);
  });

  it('defaults to at most 10 when limit is not given', async () => {
    const bundle = await recallMemory('deployment rollout canary pipeline', {});
    expect(bundle.memories.length).toBeGreaterThan(0);
    expect(bundle.memories.length).toBeLessThanOrEqual(10);
  });
});
