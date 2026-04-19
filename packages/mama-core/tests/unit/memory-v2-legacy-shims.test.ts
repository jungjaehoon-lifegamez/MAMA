import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { SEARCH_RANKER_FEATURE_SET_VERSION } from '../../src/search/ranker-features.js';

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
    vi.resetModules();
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

  it('should rerank a larger memory candidate pool before truncating to the requested limit', async () => {
    recallMemoryMock.mockResolvedValueOnce({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      fused_hits: [
        {
          source_type: 'wiki_page',
          source_id: 'cases/base-top.md',
          fused_rank_score: 0.55,
          page_type: 'case',
          case_id: 'case-base-top',
          record: {
            title: 'Base Top Case',
            content: 'This is first before rerank',
            confidence: 'high',
            created_at: Date.now(),
          },
        },
        {
          source_type: 'decision',
          source_id: 'promoted-second',
          fused_rank_score: 0.5,
          record: {
            topic: 'promoted_second',
            summary: 'Promoted second result',
            details: 'This should win after rerank',
            confidence: 0.5,
            created_at: Date.now(),
          },
        },
      ],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: {
        query: 'rerank me',
        scope_order: ['project'],
        retrieval_sources: ['sql_like'],
      },
    });

    const { initDB, getAdapter } = await import('../../src/db-manager.js');
    await initDB();
    getAdapter()
      .prepare(
        `
          INSERT INTO case_truth (
            case_id, title, status, created_at, updated_at
          ) VALUES (?, ?, 'active', ?, ?)
        `
      )
      .run(
        'case-base-top',
        'Base Top Case',
        '2026-04-18T00:00:00.000Z',
        '2026-04-18T00:00:00.000Z'
      );
    getAdapter()
      .prepare(
        `
          INSERT INTO ranker_model_versions (
            model_id, model_version, feature_set_version, coefficients_json, metrics_json,
            training_window_json, baseline_metrics_json, quality_gate_status, trained_at,
            trained_by, active
          )
          VALUES (
            'ranker-active', 'v1', ?, ?, '{}', '{}', '{}', 'passed',
            '2026-04-18T00:00:00.000Z', 'test', 1
          )
        `
      )
      .run(
        SEARCH_RANKER_FEATURE_SET_VERSION,
        JSON.stringify({
          coefficients: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
          intercept: 0,
          question_type_weights: {
            correction: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
            artifact: [0, 0, 0, 0, 0, -4, -4, -4, 4, -4, 0, 0, 0, 0, 0, 0, 0],
            timeline: [0, 0, 0, 0, 0, -4, -4, -4, -4, 4, 0, 0, 0, 0, 0, 0, 0],
            status: [0, 0, 0, 0, 0, -4, -4, 4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
            decision_reason: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
            how_to: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
            unknown: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
          },
          training_rows_count: 10,
        })
      );

    const mama = (await import('../../src/mama-api.js')).default;
    const result = await mama.suggest('rerank me', { limit: 1, rerankWithLearned: true });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe('promoted-second');
    expect(result.meta?.ranker?.applied).toBe(true);
  });
});
