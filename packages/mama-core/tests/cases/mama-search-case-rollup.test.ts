import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/embeddings.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/embeddings.js')>('../../src/embeddings.js');
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => queryVector()),
  };
});

import {
  bindMemoryToScope,
  ensureMemoryScope,
  fts5Search,
  getAdapter,
  vectorSearch,
} from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { rollUpSearchHits, type SearchRollupLeafHit } from '../../src/cases/search-rollup.js';
import { upsertWikiPageIndexEntry } from '../../src/cases/wiki-page-index.js';
import mamaApi, { suggest } from '../../src/mama-api.js';
import type { SearchHitDiagnostics } from '../../src/search/search-quality.js';
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
  adapter.prepare('DELETE FROM memory_scope_bindings').run();
  adapter.prepare('DELETE FROM memory_scopes').run();
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

function insertMembership(
  caseId: string,
  sourceId: string,
  sourceType: 'decision' | 'checkpoint' = 'decision'
): void {
  const adapter = getAdapter();
  const now = nowIso();
  adapter
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status,
          added_by, added_at, updated_at, user_locked
        )
        VALUES (?, ?, ?, 'supporting', 0.9, 'test', 'active', 'wiki-compiler', ?, ?, 0)
      `
    )
    .run(caseId, sourceType, sourceId, now, now);
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

async function bindDecisionScope(
  memoryId: string,
  scope: { kind: 'global' | 'user' | 'channel' | 'project'; id: string },
  isPrimary = true
): Promise<void> {
  const scopeId = await ensureMemoryScope(scope.kind, scope.id);
  await bindMemoryToScope(memoryId, scopeId, isPrimary);
}

function leaf(
  sourceId: string,
  score: number,
  record: Record<string, unknown> = {},
  retrievalDiagnostics?: SearchHitDiagnostics
): SearchRollupLeafHit {
  return {
    source_type: 'decision',
    source_id: sourceId,
    fused_rank_score: score,
    retrieval_diagnostics: retrievalDiagnostics,
    record: {
      id: sourceId,
      topic: sourceId,
      summary: sourceId,
      details: '',
      ...record,
    },
  };
}

function diagnostics(input: {
  source?: string;
  vectorSimilarity?: number | null;
  lexical?: boolean;
  entity?: boolean;
  scope?: boolean;
  graphSource?: 'primary' | 'expanded' | null;
  vectorOnly?: boolean;
  confirmations?: string[];
  metadata?: string[];
  threshold?: number;
}): SearchHitDiagnostics {
  return {
    retrieval_source: input.source ?? 'hybrid_rrf',
    vector_similarity: input.vectorSimilarity ?? null,
    lexical_support: input.lexical ?? false,
    entity_support: input.entity ?? false,
    scope_support: input.scope ?? true,
    graph_source: input.graphSource ?? 'primary',
    is_vector_only: input.vectorOnly ?? false,
    confirmation_signals: input.confirmations ?? (input.lexical ? ['lexical'] : []),
    metadata_signals: input.metadata ?? ['graph_primary'],
    candidate_threshold_used: input.threshold ?? 0.45,
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

  it('does not return the same case twice when a direct wiki hit arrives after grouped leaves', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-wiki-late' });
    insertMembership('case-wiki-late', 'D-late');

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [
        leaf('D-late', 4),
        {
          source_type: 'wiki_page',
          source_id: 'cases/late-direct.md',
          fused_rank_score: 7,
          page_type: 'case',
          case_id: 'case-wiki-late',
          record: {
            source_locator: 'cases/late-direct.md',
            title: 'Late direct hit',
            content: 'body',
          },
        },
      ],
    });

    expect(results.filter((result) => result.case_id === 'case-wiki-late')).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: 'case',
      case_id: 'case-wiki-late',
      score: 7,
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

  it('preserves strongest retrieval diagnostics and all contributing leaf diagnostics', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-diagnostics' });
    insertMembership('case-diagnostics', 'D-vector');
    insertMembership('case-diagnostics', 'D-lexical');

    const vectorOnlyDiagnostics = diagnostics({
      source: 'vector_search',
      vectorSimilarity: 0.88,
      graphSource: 'expanded',
      vectorOnly: true,
      confirmations: [],
      metadata: ['graph_expanded'],
    });
    const confirmedDiagnostics = diagnostics({
      source: 'hybrid_rrf',
      vectorSimilarity: 0.93,
      lexical: true,
      graphSource: 'primary',
      vectorOnly: false,
      confirmations: ['lexical'],
      metadata: ['graph_primary'],
    });

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [
        leaf('D-vector', 10, {}, vectorOnlyDiagnostics),
        leaf('D-lexical', 8, {}, confirmedDiagnostics),
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].retrieval_diagnostics).toMatchObject({
      retrieval_source: 'hybrid_rrf',
      graph_source: 'primary',
      is_vector_only: false,
      confirmation_signals: ['lexical'],
    });
    expect(results[0].contributing_leaf_diagnostics).toMatchObject({
      'D-vector': expect.objectContaining({
        retrieval_source: 'vector_search',
        is_vector_only: true,
      }),
      'D-lexical': expect.objectContaining({
        retrieval_source: 'hybrid_rrf',
        lexical_support: true,
      }),
    });
  });

  it('prefers confirmed diagnostics before metadata-only graph/source signals', () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-diagnostics-rank' });
    insertMembership('case-diagnostics-rank', 'D-primary-vector');
    insertMembership('case-diagnostics-rank', 'D-expanded-unconfirmed');

    const vectorOnlyPrimary = diagnostics({
      source: 'vector_search',
      vectorSimilarity: 0.88,
      graphSource: 'primary',
      vectorOnly: true,
      confirmations: [],
      metadata: ['graph_primary'],
    });
    const unconfirmedExpanded = diagnostics({
      source: 'graph_expansion',
      vectorSimilarity: null,
      graphSource: 'expanded',
      vectorOnly: false,
      confirmations: [],
      metadata: ['graph_expanded'],
    });

    const results = rollUpSearchHits({
      adapter,
      fusedHits: [
        leaf('D-primary-vector', 10, {}, vectorOnlyPrimary),
        leaf('D-expanded-unconfirmed', 8, {}, unconfirmedExpanded),
      ],
    });

    expect(results[0].retrieval_diagnostics).toMatchObject({
      retrieval_source: 'vector_search',
      graph_source: 'primary',
      confirmation_signals: [],
    });
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

  it('surfaces memory_v2 diagnostics through suggest case roll-up', async () => {
    insertCase({ case_id: 'case-diagnostic-path', title: 'Diagnostic Path Case' });
    insertMembership('case-diagnostic-path', 'decision_diagnostic_path');
    insertDecision({
      id: 'decision_diagnostic_path',
      topic: 'diagnostic path topic',
      decision: 'diagnosticpathtoken decision body',
      reasoning: 'diagnostic path reasoning',
      embedding: unitVector(1),
    });

    const result = await suggest('diagnosticpathtoken', {
      limit: 5,
      diagnostics: true,
      strictness: 'balanced',
    });
    const rows = (result.results ?? []) as Array<Record<string, unknown>>;

    expect(result.diagnostics?.candidate_counts.lexical).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      id: 'case-diagnostic-path',
      source_type: 'case',
      case_id: 'case-diagnostic-path',
      graph_source: 'primary',
      retrieval_diagnostics: expect.objectContaining({
        lexical_support: true,
        graph_source: 'primary',
        is_vector_only: false,
        confirmation_signals: ['lexical'],
      }),
      contributing_leaf_diagnostics: {
        decision_diagnostic_path: expect.objectContaining({
          lexical_support: true,
          is_vector_only: false,
        }),
      },
    });
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

  it('does not return wiki vector-only hits in strict search', async () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-wiki-vector-only', title: 'Wiki Vector Only Case' });

    upsertWikiPageIndexEntry(adapter, {
      source_locator: 'cases/wiki-vector-only.md',
      page_type: 'case',
      title: 'Wiki Vector Only',
      content: 'Compiled case body without the requested strict token',
      case_id: 'case-wiki-vector-only',
      source_ids: [],
      entity_refs: [],
      confidence: 'high',
      compiled_at: nowIso(),
      embedding: unitVector(1),
    });

    const result = await suggest('strictwikivectornoise', {
      limit: 5,
      strictness: 'strict',
      diagnostics: true,
    });

    expect(result.results).toEqual([]);
    expect(result.diagnostics?.candidate_counts.vector_only).toBeGreaterThan(0);
    expect(result.diagnostics?.candidate_counts.rejected_by_strictness).toBeGreaterThan(0);
  });

  it('does not return unconfirmed graph-expanded hits in balanced search', async () => {
    const now = Date.now();
    insertDecision({
      id: 'decision_graph_primary',
      topic: 'graph primary topic',
      decision: 'graphprimarytoken confirmed primary decision',
      reasoning: 'primary lexical support',
      embedding: unitVector(1),
    });
    insertDecision({
      id: 'decision_graph_expanded_noise',
      topic: 'unrelated expanded topic',
      decision: 'expanded graph neighbor without query support',
      reasoning: 'graph-only neighbor',
      embedding: unitVector(0.1),
    });

    const graphSpy = vi.spyOn(mamaApi, 'expandWithGraph').mockResolvedValueOnce([
      {
        id: 'decision_graph_primary',
        topic: 'graph primary topic',
        decision: 'graphprimarytoken confirmed primary decision',
        confidence: 0.9,
        created_at: now,
        graph_source: 'primary',
        graph_rank: 1,
      },
      {
        id: 'decision_graph_expanded_noise',
        topic: 'unrelated expanded topic',
        decision: 'expanded graph neighbor without query support',
        confidence: 0.95,
        created_at: now,
        graph_source: 'expanded',
        graph_rank: 0.95,
      },
    ]);

    try {
      const result = await suggest('graphprimarytoken', {
        limit: 10,
        strictness: 'balanced',
        includeRelated: true,
        diagnostics: true,
      });
      const ids = (result.results ?? []).map((row: Record<string, unknown>) => row.id);

      expect(ids).toContain('decision_graph_primary');
      expect(ids).not.toContain('decision_graph_expanded_noise');
      expect(result.diagnostics?.candidate_counts.graph_expanded).toBe(0);
    } finally {
      graphSpy.mockRestore();
    }
  });

  it('does not return wiki hits outside requested memory scopes', async () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-wiki-outside-scope', title: 'Wiki Outside Scope' });
    insertDecision({
      id: 'decision_wiki_outside_scope_source',
      topic: 'outside scope source',
      decision: 'outside source decision',
      reasoning: 'source is bound to beta',
    });
    await bindDecisionScope('decision_wiki_outside_scope_source', {
      kind: 'project',
      id: 'beta',
    });
    insertMembership('case-wiki-outside-scope', 'decision_wiki_outside_scope_source');

    upsertWikiPageIndexEntry(adapter, {
      source_locator: 'cases/wiki-outside-scope.md',
      page_type: 'case',
      title: 'Wiki Outside Scope',
      content: 'scopedwikitoken appears only in compiled markdown',
      case_id: 'case-wiki-outside-scope',
      source_ids: ['decision_wiki_outside_scope_source'],
      entity_refs: [],
      confidence: 'high',
      compiled_at: nowIso(),
    });

    const result = await suggest('scopedwikitoken', {
      limit: 5,
      strictness: 'balanced',
      diagnostics: true,
      scopes: [{ kind: 'project', id: 'alpha' }],
    });

    expect(result.results).toEqual([]);
  });

  it('does not return wiki hits outside topicPrefix source evidence', async () => {
    const adapter = getAdapter();
    insertCase({ case_id: 'case-wiki-topic-prefix', title: 'Wiki Topic Prefix' });
    insertDecision({
      id: 'decision_wiki_topic_prefix_source',
      topic: 'beta/wiki/source',
      decision: 'topic prefix source decision',
      reasoning: 'source topic is outside alpha prefix',
    });
    insertMembership('case-wiki-topic-prefix', 'decision_wiki_topic_prefix_source');

    upsertWikiPageIndexEntry(adapter, {
      source_locator: 'cases/wiki-topic-prefix.md',
      page_type: 'case',
      title: 'Wiki Topic Prefix',
      content: 'prefixedwikitoken appears only in compiled markdown',
      case_id: 'case-wiki-topic-prefix',
      source_ids: ['decision_wiki_topic_prefix_source'],
      entity_refs: [],
      confidence: 'high',
      compiled_at: nowIso(),
    });

    const result = await suggest('prefixedwikitoken', {
      limit: 5,
      strictness: 'balanced',
      topicPrefix: 'alpha/',
    });

    expect(result.results).toEqual([]);
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
