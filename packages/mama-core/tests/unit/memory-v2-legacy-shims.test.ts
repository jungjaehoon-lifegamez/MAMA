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

vi.mock('../../src/memory/api.js', () => ({
  saveMemory: saveMemoryMock,
  recallMemory: recallMemoryMock,
  buildProfile: vi.fn(),
  ingestMemory: vi.fn(),
  evolveMemory: vi.fn(),
  buildMemoryBootstrap: vi.fn(),
  createAuditAck: vi.fn((input) => input),
  recordMemoryAudit: vi.fn(),
  upsertChannelSummary: vi.fn(),
  getChannelSummary: vi.fn(),
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

  it('should expose suggest results without inflating similarity from rank order fallback', async () => {
    recallMemoryMock.mockResolvedValueOnce({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [
        {
          id: 'shim_memory_ranked',
          topic: 'legacy_save_contract',
          summary: 'Keep legacy save alive',
          details: 'Migration shim',
          confidence: 1,
          status: 'active',
          kind: 'decision',
          scopes: [],
          source: { package: 'mama-core', source_type: 'test' },
          created_at: Date.now(),
          updated_at: Date.now(),
          event_date: '2026-04-15',
        },
      ],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'legacy save', scope_order: ['project'], retrieval_sources: ['sql_like'] },
    });

    const mama = (await import('../../src/mama-api.js')).default;
    const result = await mama.suggest('legacy save', { limit: 5 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.similarity).toBeNull();
    expect(result.results[0]?.retrieval_score).toBe(1);
    expect(result.results[0]?.event_date).toBe('2026-04-15');
  });

  it('should not raise a save warning from retrieval-rank normalization alone', async () => {
    recallMemoryMock.mockResolvedValueOnce({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [
        {
          id: 'shim_memory_warning',
          topic: 'legacy_save_warning_contract',
          summary: 'Potential duplicate by rank',
          details: 'Ranked first by recallMemory',
          confidence: 1,
          status: 'active',
          kind: 'decision',
          scopes: [],
          source: { package: 'mama-core', source_type: 'test' },
          created_at: Date.now(),
          updated_at: Date.now(),
          event_date: '2026-04-14',
        },
      ],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: {
        query: 'legacy_save_warning_contract',
        scope_order: ['project'],
        retrieval_sources: ['sql_like'],
      },
    });

    const mama = (await import('../../src/mama-api.js')).default;
    const result = await mama.save({
      topic: 'legacy_save_warning_contract',
      decision: 'Keep rank and similarity separate',
      reasoning: 'Regression guard for save warning',
    });

    expect(result.similar_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'shim_memory_warning',
          similarity: null,
          retrieval_score: 1,
          event_date: '2026-04-14',
        }),
      ])
    );
    expect(result.warning).toBeUndefined();
  });
});
