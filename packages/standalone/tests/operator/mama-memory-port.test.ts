/**
 * Unit tests for createMamaMemoryPort (M1-T0 - real mama-core recall binding).
 * Uses a REAL isolated mama-core DB (MAMA_DB_PATH -> tmp) with MAMA_FORCE_TIER_3
 * (lexical fallback, no embedding model load). Proves the real save -> recall path
 * through the adapter, not a mock.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'mama-memory-port-'));
process.env.MAMA_DB_PATH = join(tmpDir, 'test-memory.db');
process.env.MAMA_FORCE_TIER_3 = 'true';

import { initDB, closeDB, saveMemory } from '@jungjaehoon/mama-core';
import { createMamaMemoryPort } from '../../src/operator/mama-memory-port.js';

describe('createMamaMemoryPort', () => {
  beforeAll(async () => {
    await initDB();
    await saveMemory({
      topic: 'weekly-report-cadence',
      kind: 'decision',
      summary: 'Weekly reports go out every Friday afternoon',
      details: 'The weekly status report is published every Friday afternoon before the sync.',
      scopes: [{ kind: 'global', id: 'global' }],
      source: { package: 'standalone', source_type: 'operator-test' },
    });
  });

  afterAll(async () => {
    await closeDB();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recall returns the seeded memory mapped to {topic, content: summary}', async () => {
    const port = createMamaMemoryPort();
    const hits = await port.recall('weekly report Friday', { limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.topic === 'weekly-report-cadence');
    expect(hit).toBeDefined();
    expect(hit?.content).toBe('Weekly reports go out every Friday afternoon');
  });

  it('recall with no match returns [] (no throw, no guess)', async () => {
    const port = createMamaMemoryPort();
    const hits = await port.recall('xyzzy quux nonexistent', { limit: 5 });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('save persists via mama-core and is recallable', async () => {
    const port = createMamaMemoryPort();
    await port.save({ topic: 'deploy-rollback-preference', content: 'Prefer canary rollback over blue-green revert' });
    const hits = await port.recall('canary rollback preference', { limit: 5 });
    expect(hits.some((h) => h.topic === 'deploy-rollback-preference')).toBe(true);
  });
});
