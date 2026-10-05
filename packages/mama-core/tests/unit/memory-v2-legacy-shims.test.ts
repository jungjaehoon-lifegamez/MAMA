/**
 * The legacy `mama.save` and `mama.suggest` shims, through the path they take.
 *
 * `suggestInAdapter` used to live in `mama-api.ts` and reach recall across a
 * module boundary, so the suggest shims stood on a `vi.mock` of
 * `memory/api.js`'s `recallMemory`. Judgment D of the unified-core plan moved
 * the five `*InAdapter` functions into `memory/api.ts`, where `recallMemory`
 * already was: that boundary is gone, and a mock of it would now be a module
 * intercepting itself — green while exercising nothing. The suggest shims are
 * stated here against seeded rows and the real recall, the way
 * `tests/knowledge/mama-search-case-rollup.test.ts` states the same pipeline.
 *
 * The save shim keeps its double: `mama-api.ts` still imports `saveMemory`
 * across the module boundary it always had.
 *
 * What a save reports about related decisions (similarity absent, no warning
 * from rank alone) is pinned end to end in
 * `tests/unit/save-similarity-is-not-rank.test.ts`; it is not restated here.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

// The embedder is the model, not an internal component: fixing the query vector
// is what makes "which hit ranks first" a statement about the pipeline rather
// than about today's checkpoint of multilingual-e5-large.
vi.mock('../../src/embedding/embedder.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/embedding/embedder.js')>(
    '../../src/embedding/embedder.js'
  );
  return { ...actual, generateEmbedding: vi.fn(async () => queryVector()) };
});

const saveMemoryMock = vi.fn(async () => ({ success: true, id: 'shim_saved' }));

vi.mock('../../src/memory/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/api.js')>();
  return { ...actual, saveMemory: saveMemoryMock, saveLegacyMemory: saveMemoryMock };
});

function queryVector(): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = 1;
  return vector;
}

let testDbPath = '';

async function adapter() {
  const { getAdapter } = await import('../../src/db-manager.js');
  return getAdapter();
}

async function insertDecision(input: {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string;
  kind?: string;
  event_date?: string | null;
  embedding?: Float32Array;
}): Promise<void> {
  const db = await adapter();
  const now = Date.now();
  db.prepare(
    `INSERT INTO decisions (
       id, topic, decision, reasoning, confidence, created_at, updated_at,
       kind, status, summary, event_date, event_datetime
     ) VALUES (?, ?, ?, ?, 0.8, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(
    input.id,
    input.topic,
    input.decision,
    input.reasoning ?? '',
    now,
    now,
    input.kind ?? 'decision',
    input.decision,
    input.event_date ?? null,
    now
  );
  if (input.embedding) {
    const row = db.prepare('SELECT rowid FROM decisions WHERE id = ?').get(input.id) as {
      rowid: number;
    };
    db.insertEmbedding(row.rowid, input.embedding);
  }
  db.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();
}

describe('legacy shims', () => {
  beforeAll(async () => {
    process.env.MAMA_ENTITY_PROJECTION_MODE = 'off';
    testDbPath = await initTestDB('memory-v2-legacy-shims');
  });

  afterEach(async () => {
    const db = await adapter();
    db.prepare('DELETE FROM case_memberships').run();
    db.prepare('DELETE FROM case_truth').run();
    db.prepare('DELETE FROM embeddings').run();
    db.prepare('DELETE FROM decisions').run();
    db.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();
    saveMemoryMock.mockClear();
  });

  afterAll(async () => {
    delete process.env.MAMA_ENTITY_PROJECTION_MODE;
    await cleanupTestDB(testDbPath);
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

  it('answers mama.suggest from memory_v2 over what is stored', async () => {
    await insertDecision({
      id: 'shim_memory_ranked',
      topic: 'legacy save contract',
      decision: 'legacysavetoken keep legacy save alive',
      reasoning: 'Migration shim',
      event_date: '2026-04-15',
    });

    const mama = (await import('../../src/mama-api.js')).default;
    const result = await mama.suggest('legacysavetoken', { limit: 5 });

    expect(result.meta?.search_method).toBe('memory_v2');
    expect(result.results).toHaveLength(1);
    // Rank is not likeness: the score that ordered the result is reported as a
    // retrieval score, and `similarity` stays absent rather than echoing it.
    // The score is Reciprocal Rank Fusion with RRF_K = 60, so the single hit
    // scores 1/61 — a position, which is exactly why it is not a percentage.
    expect(result.results[0]?.similarity).toBeNull();
    expect(result.results[0]?.retrieval_score).toBeCloseTo(1 / 61, 12);
    expect(result.results[0]?.event_date).toBe('2026-04-15');
  });

  it('does not widen a requested quality contract with the legacy keyword search', async () => {
    // This row matches the query by plain keyword, so the legacy LIKE fallback
    // would return it. The caller asked for a topic prefix the row is outside
    // of, and memory_v2 answers nothing — the contract stands rather than being
    // quietly replaced by a wider search.
    await insertDecision({
      id: 'legacy_keyword_noise',
      topic: 'context compile',
      decision: 'contextcompiletoken legacy keyword fallback would return this row',
      reasoning: 'Outside the requested topic prefix.',
    });

    const mama = (await import('../../src/mama-api.js')).default;
    const result = await mama.suggest('contextcompiletoken', {
      limit: 5,
      topicPrefix: 'unrelated/prefix',
      diagnostics: true,
    });

    expect(result.results).toEqual([]);
    expect(result.meta?.search_method).toBe('memory_v2');
  });
});
