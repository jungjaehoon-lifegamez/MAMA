import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

const TEST_DB = '/tmp/test-memory-v2-legacy-shims.db';

const saveMemoryMock = vi.fn(async () => ({ success: true, id: 'shim_saved' }));
const recallMemoryMock = vi.fn(async () => ({
  profile: { static: [], dynamic: [], evidence: [] },
  memories: [
    {
      id: 'shim_memory',
      topic: 'legacy_save_contract',
      summary: 'Keep legacy save alive',
      details: 'Migration shim',
      confidence: 0.9,
      status: 'active',
      kind: 'decision',
      scopes: [],
      source: { package: 'mama-core', source_type: 'test' },
      created_at: Date.now(),
      updated_at: Date.now(),
    },
  ],
  graph_context: { primary: [], expanded: [], edges: [] },
  search_meta: { query: 'legacy save', scope_order: ['project'], retrieval_sources: ['sql_like'] },
}));

vi.mock('../../src/memory-v2/api.js', () => ({
  saveMemory: saveMemoryMock,
  recallMemory: recallMemoryMock,
  buildProfile: vi.fn(),
  ingestMemory: vi.fn(),
  evolveMemory: vi.fn(),
}));

describe('legacy shims', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
  });

  beforeEach(() => {
    saveMemoryMock.mockClear();
    recallMemoryMock.mockClear();
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;

    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should keep mama.save working', async () => {
    const mama = (await import('../../src/mama-api.js')).default;
    const result = await mama.save({
      topic: 'legacy_save_contract',
      decision: 'Keep legacy save alive',
      reasoning: 'Migration shim',
    });

    expect(result.success).toBe(true);
    expect(saveMemoryMock).toHaveBeenCalled();
  });

  it('should keep mama.suggest working while exposing recall bundle support', async () => {
    const mama = (await import('../../src/mama-api.js')).default;
    const result = await mama.suggest('legacy save', { limit: 5 });

    expect(recallMemoryMock).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
