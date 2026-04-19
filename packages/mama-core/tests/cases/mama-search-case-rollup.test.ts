import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/embeddings.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/embeddings.js')>('../../src/embeddings.js');
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => queryVector()),
  };
});

import { fts5Search, getAdapter, vectorSearch } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { rollUpSearchHits, type SearchRollupLeafHit } from '../../src/cases/search-rollup.js';
import { upsertWikiPageIndexEntry } from '../../src/cases/wiki-page-index.js';
import { suggest } from '../../src/mama-api.js';
import { handleSearch } from '../../../standalone/src/agent/mama-tool-handlers.js';
import type { MAMAApiInterface } from '../../../standalone/src/agent/types.js';

let testDbPath = '';
let originalProjectionMode: string | undefined;

function queryVector(): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = 1;
  return vector;
}

function unitVector(cosine: number): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = cosine;
  vector[1] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return vector;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanupRows(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM wiki_page_index').run();
  adapter
    .prepare('UPDATE case_truth SET canonical_case_id = NULL, split_from_case_id = NULL')
    .run();
  adapter.prepare('DELETE FROM case_truth').run();
  adapter.prepare('DELETE FROM embeddings').run();
  adapter.prepare('DELETE FROM decisions').run();
}

function insertCase(input: {
  case_id: string;
  title?: string;
  status?: string;
  canonical_case_id?: string | null;
}): void {
  const adapter = getAdapter();
  const now = nowIso();
  adapter
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, canonical_case_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.case_id,
      `cases/${input.case_id}.md`,
      input.title ?? input.case_id,
      input.status ?? 'active',
      input.canonical_case_id ?? null,
      now,
      now
    );
}

function insertMembership(caseId: string, sourceId: string): void {
  const adapter = getAdapter();
  const now = nowIso();
  adapter
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status,
          added_by, added_at, updated_at, user_locked
        )
        VALUES (?, 'decision', ?, 'supporting', 0.9, 'test', 'active', 'wiki-compiler', ?, ?, 0)
      `
    )
    .run(caseId, sourceId, now, now);
}

function insertDecision(input: {
  id: string;
  topic?: string;
  decision?: string;
  reasoning?: string;
  embedding?: Float32Array;
}): void {
  const adapter = getAdapter();
  const now = Date.now();
  adapter
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, created_at, updated_at,
          kind, status, summary, event_datetime
        )
        VALUES (?, ?, ?, ?, 0.8, ?, ?, 'decision', 'active', ?, ?)
      `
    )
    .run(
      input.id,
      input.topic ?? input.id,
      input.decision ?? input.id,
      input.reasoning ?? '',
      now,
      now,
      input.decision ?? input.id,
      now
    );

  if (input.embedding) {
    const row = adapter.prepare('SELECT rowid FROM decisions WHERE id = ?').get(input.id) as {
      rowid: number;
    };
    adapter.insertEmbedding(row.rowid, input.embedding);
  }

  // Rebuild FTS5 index — external-content FTS5 with trigger-based sync requires
  // an explicit rebuild to populate the tokenized index after raw SQL INSERTs.
  adapter.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();
}

function leaf(
  sourceId: string,
  score: number,
  record: Record<string, unknown> = {}
): SearchRollupLeafHit {
  return {
    source_type: 'decision',
    source_id: sourceId,
    fused_rank_score: score,
    record: {
      id: sourceId,
      topic: sourceId,
      summary: sourceId,
      details: '',
      ...record,
    },
  };
}

describe('Task 11: mama_search case membership roll-up', () => {
  beforeAll(async () => {
    originalProjectionMode = process.env.MAMA_ENTITY_PROJECTION_MODE;
    process.env.MAMA_ENTITY_PROJECTION_MODE = 'off';
    testDbPath = await initTestDB('mama-search-case-rollup');
  });

  afterEach(() => {
    cleanupRows();
  });

  afterAll(async () => {
    if (originalProjectionMode === undefined) {
      delete process.env.MAMA_ENTITY_PROJECTION_MODE;
    } else {
      process.env.MAMA_ENTITY_PROJECTION_MODE = originalProjectionMode;
    }
    await cleanupTestDB(testDbPath);
  });

  it('rolls a decision hit with one active membership up to one case result', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-one' });
    insertMembership('case-one', 'D1');

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [leaf('D1', 10)],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: 'case',
      source_id: 'case-one',
      case_id: 'case-one',
      score: 10,
      contributing_leaves: ['D1'],
    });
  });

  it('emits one case result per active membership when a decision belongs to two cases', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });
    insertMembership('case-a', 'D1');
    insertMembership('case-b', 'D1');

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [leaf('D1', 7)],
    });

    expect(results.map((result) => result.case_id).sort()).toEqual(['case-a', 'case-b']);
    expect(results.every((result) => result.score === 7)).toBe(true);
  });

  it('de-dupes duplicate leaf contributions by case_id and leaf source_id', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-dedupe' });
    insertMembership('case-dedupe', 'D1');

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [leaf('D1', 10), leaf('D1', 10)],
    });

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(10);
    expect(results[0].contributing_leaves).toEqual(['D1']);
  });

  it('canonicalizes merged loser memberships to the survivor before de-duplication', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-survivor' });
    insertCase({
      case_id: 'case-loser',
      status: 'merged',
      canonical_case_id: 'case-survivor',
    });
    insertMembership('case-survivor', 'D1');
    insertMembership('case-loser', 'D1');

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [leaf('D1', 10)],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: 'case',
      source_id: 'case-survivor',
      case_id: 'case-survivor',
      score: 10,
      contributing_leaves: ['D1'],
    });
  });

  it('leaves orphan decisions as leaf results with case_id null', () => {
    const adapter = getAdapter();

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [leaf('D-orphan', 5)],
    });

    expect(results).toEqual([
      expect.objectContaining({
        source_type: 'decision',
        source_id: 'D-orphan',
        case_id: null,
        score: 5,
      }),
    ]);
  });

  it('returns case wiki page hits directly without joining memberships', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-wiki-direct' });

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [
        {
          source_type: 'wiki_page',
          source_id: 'cases/direct.md',
          fused_rank_score: 6,
          page_type: 'case',
          case_id: 'case-wiki-direct',
          record: {
            source_locator: 'cases/direct.md',
            title: 'Direct wiki case',
            content: 'body',
          },
        },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: 'case',
      source_id: 'case-wiki-direct',
      case_id: 'case-wiki-direct',
      score: 6,
      contributing_leaves: ['cases/direct.md'],
    });
  });

  it('orders summed case scores above lower-scored cases in injected fixture 1', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'C1' });
    insertCase({ case_id: 'C2' });
    insertMembership('C1', 'D1');
    insertMembership('C1', 'D2');
    insertMembership('C2', 'D3');

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [leaf('D1', 10), leaf('D2', 5), leaf('D3', 8)],
    });

    expect(results.map((result) => [result.case_id, result.score])).toEqual([
      ['C1', 15],
      ['C2', 8],
    ]);
  });

  it('interleaves orphan leaves on the shared score axis in injected fixture 2', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'C1' });
    insertCase({ case_id: 'C2' });
    insertMembership('C1', 'D1');
    insertMembership('C2', 'D3');

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [leaf('D1', 10), leaf('D2', 5), leaf('D3', 8)],
    });

    expect(
      results.map((result) => [result.source_type, result.case_id, result.source_id, result.score])
    ).toEqual([
      ['case', 'C1', 'C1', 10],
      ['case', 'C2', 'C2', 8],
      ['decision', null, 'D2', 5],
    ]);
  });

  it.each([
    {
      name: 'suggest',
      run: async (query: string) => suggest(query, { limit: 5 }),
    },
    {
      name: 'handleSearch',
      run: async (query: string) =>
        handleSearch(
          {
            suggest,
            listDecisions: async () => [],
            loadCheckpoint: async () => null,
          } as unknown as MAMAApiInterface,
          { query, limit: 5 }
        ),
    },
  ])('$name applies roll-up and preserves plugin-compatible fields', async ({ run }) => {
    insertCase({ case_id: 'case-public-path', title: 'Public Path Case' });
    insertMembership('case-public-path', 'decision_public_path');
    insertDecision({
      id: 'decision_public_path',
      topic: 'public path topic',
      decision: 'publicpathtoken decision body',
      reasoning: 'public path reasoning',
      embedding: unitVector(1),
    });

    const result = await run('publicpathtoken');
    const rows = (result.results ?? []) as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      id: 'case-public-path',
      source_type: 'case',
      case_id: 'case-public-path',
    });
    expect(rows[0]).toHaveProperty('topic');
    expect(rows[0]).toHaveProperty('decision');
    expect(rows[0]).toHaveProperty('reasoning');
    expect(rows[0]).toHaveProperty('confidence');
    expect(rows[0]).toHaveProperty('retrieval_score');
  });

  it('returns a case result when the query matches only wiki_page_index content', async () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-wiki-only', title: 'Wiki Only Case' });

    upsertWikiPageIndexEntry(adapter, {
      source_locator: 'cases/wiki-only.md',
      page_type: 'case',
      title: 'Wiki Only',
      content: 'wikionlytoken appears only in compiled markdown',
      case_id: 'case-wiki-only',
      source_ids: [],
      entity_refs: [],
      confidence: 'high',
      compiled_at: nowIso(),
    });

    const result = await suggest('wikionlytoken', { limit: 5 });
    const rows = result.results as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      source_type: 'case',
      case_id: 'case-wiki-only',
      id: 'case-wiki-only',
    });
  });

  it('feeds fused RRF scores into roll-up before case scoring in the production search path', async () => {
    insertCase({ case_id: 'C1' });
    insertCase({ case_id: 'C2' });
    insertMembership('C1', 'D1');
    insertMembership('C1', 'D2');
    insertMembership('C2', 'D3');

    insertDecision({
      id: 'D3',
      topic: 'rrffusiontoken rrffusiontoken rrffusiontoken',
      decision: 'rrffusiontoken rrffusiontoken rrffusiontoken',
      embedding: unitVector(0.9),
    });
    insertDecision({
      id: 'D1',
      topic: 'rrffusiontoken rrffusiontoken',
      decision: 'rrffusiontoken rrffusiontoken',
      embedding: unitVector(1),
    });
    insertDecision({
      id: 'D2',
      topic: 'rrffusiontoken',
      decision: 'rrffusiontoken',
      embedding: unitVector(0.95),
    });

    const ftsIds = (await fts5Search('rrffusiontoken', 3)).map((row) => row.id);
    const vectorIds = (await vectorSearch(queryVector(), 3, 0)).map((row) => row.id);
    expect(ftsIds).toEqual(['D3', 'D1', 'D2']);
    expect(vectorIds).toEqual(['D1', 'D2', 'D3']);

    const result = await suggest('rrffusiontoken', { limit: 5 });
    const rows = result.results as Array<Record<string, unknown>>;

    expect(rows.slice(0, 2).map((row) => row.case_id)).toEqual(['C1', 'C2']);
    expect(Number(rows[0].retrieval_score)).toBeGreaterThan(Number(rows[1].retrieval_score));
  });
});
