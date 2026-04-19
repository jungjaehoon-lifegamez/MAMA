import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { matchEventToExistingCases } from '../../src/cases/membership-matcher.js';

function resetCaseTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM wiki_page_embeddings').run();
  adapter.prepare('DELETE FROM wiki_page_index').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_truth').run();
}

function insertCase(
  overrides: Partial<{
    case_id: string;
    title: string;
    status: string;
    primary_actors: unknown;
    last_activity_at: string | null;
    compiled_at: string | null;
    confidence: string | null;
    created_at: string;
    updated_at: string;
  }>
): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, primary_actors,
          last_activity_at, confidence, compiled_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      `cases/${overrides.case_id}.md`,
      overrides.title ?? overrides.case_id,
      overrides.status ?? 'active',
      JSON.stringify(overrides.primary_actors ?? []),
      overrides.last_activity_at ?? null,
      overrides.confidence ?? null,
      overrides.compiled_at ?? null,
      overrides.created_at ?? now,
      overrides.updated_at ?? now
    );
}

function insertWikiCaseEmbedding(input: {
  page_id: string;
  case_id: string;
  embedding: Float32Array;
}): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO wiki_page_index (
          page_id, source_type, source_locator, case_id, title, page_type,
          content, confidence, compiled_at, updated_at
        )
        VALUES (?, 'wiki_page', ?, ?, ?, 'case', ?, 'high', ?, ?)
      `
    )
    .run(
      input.page_id,
      `cases/${input.case_id}.md`,
      input.case_id,
      `Case ${input.case_id}`,
      `Case content ${input.case_id}`,
      now,
      now
    );

  getAdapter()
    .prepare(
      `
        INSERT INTO wiki_page_embeddings (page_id, embedding)
        VALUES (?, ?)
      `
    )
    .run(input.page_id, Buffer.from(input.embedding.buffer));
}

describe('Story CF2.6: Case membership matching scorer', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-membership-matcher');
  });

  beforeEach(() => {
    resetCaseTables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('explicit case_id wins even with no actor overlap', () => {
    insertCase({ case_id: 'case-explicit', primary_actors: [] });

    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-explicit',
      event_text: 'unrelated text',
      event_entities: [],
      observed_at: '2026-04-18T00:00:00.000Z',
      explicit_case_id: 'case-explicit',
    });

    expect(result).toEqual([
      {
        case_id: 'case-explicit',
        score: 1,
        status: 'active',
        reason: 'explicit_case_id',
      },
    ]);
  });

  it('explicit case_id missing from case_truth returns precompile_gap', () => {
    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-missing-explicit',
      event_text: 'missing case',
      event_entities: [],
      observed_at: '2026-04-18T00:00:00.000Z',
      explicit_case_id: 'case-does-not-exist',
    });

    expect(result).toEqual({
      kind: 'precompile_gap',
      code: 'case.precompile_gap',
      case_id: 'case-does-not-exist',
    });
  });

  it('actor overlap creates active membership', () => {
    insertCase({
      case_id: 'case-actor-active',
      primary_actors: [
        { entity_id: 'entity_alice', role: 'owner' },
        { entity_id: 'entity_project', role: 'subject' },
      ],
    });

    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-actor-active',
      event_text: 'Alice updated the project.',
      event_entities: ['entity_alice', 'entity_project'],
      observed_at: '2026-04-18T00:00:00.000Z',
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      expect.objectContaining({
        case_id: 'case-actor-active',
        status: 'active',
        score: 0.9,
      }),
    ]);
  });

  it('borderline score creates candidate membership', () => {
    insertCase({
      case_id: 'case-borderline',
      primary_actors: [{ entity_id: 'entity_borderline', role: 'owner' }],
      last_activity_at: '2026-04-17T00:00:00.000Z',
    });

    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-borderline',
      event_text: 'Borderline actor update.',
      event_entities: ['entity_borderline'],
      observed_at: '2026-04-18T00:00:00.000Z',
    });

    expect(result).toEqual([
      expect.objectContaining({
        case_id: 'case-borderline',
        status: 'candidate',
        score: 0.6,
      }),
    ]);
  });

  it('no score below threshold returns []', () => {
    insertCase({
      case_id: 'case-low-score',
      primary_actors: [{ entity_id: 'entity_other', role: 'owner' }],
      last_activity_at: '2026-01-01T00:00:00.000Z',
    });

    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-low-score',
      event_text: 'No overlap.',
      event_entities: ['entity_unmatched'],
      observed_at: '2026-04-18T00:00:00.000Z',
    });

    expect(result).toEqual([]);
  });

  it('embedding hit contributes to score when query_embedding is provided', () => {
    const queryEmbedding = new Float32Array([1, 0, 0, 0]);
    insertCase({
      case_id: 'case-embedding',
      primary_actors: [{ entity_id: 'entity_embedding', role: 'owner' }],
    });
    insertWikiCaseEmbedding({
      page_id: 'page-embedding',
      case_id: 'case-embedding',
      embedding: queryEmbedding,
    });

    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-embedding',
      event_text: 'Embedding related event.',
      event_entities: ['entity_embedding'],
      observed_at: '2026-04-18T00:00:00.000Z',
      query_embedding: queryEmbedding,
    });

    expect(result).toEqual([
      expect.objectContaining({
        case_id: 'case-embedding',
        status: 'active',
        score: 0.75,
      }),
    ]);
  });

  it('missing wiki embedding does not throw and falls back to other signals', () => {
    insertCase({
      case_id: 'case-no-embedding',
      primary_actors: [{ entity_id: 'entity_no_embedding', role: 'owner' }],
      last_activity_at: '2026-04-17T00:00:00.000Z',
    });

    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-no-embedding',
      event_text: 'Fallback event.',
      event_entities: ['entity_no_embedding'],
      observed_at: '2026-04-18T00:00:00.000Z',
      query_embedding: new Float32Array([0, 1, 0, 0]),
    });

    expect(result).toEqual([
      expect.objectContaining({
        case_id: 'case-no-embedding',
        status: 'candidate',
        score: 0.6,
      }),
    ]);
  });

  it('stale, resolved, merged, split, and archived cases are not matched', () => {
    for (const status of ['stale', 'resolved', 'merged', 'split', 'archived']) {
      insertCase({
        case_id: `case-${status}`,
        status,
        primary_actors: [
          { entity_id: 'entity_status', role: 'owner' },
          { entity_id: 'entity_project', role: 'subject' },
        ],
        last_activity_at: '2026-04-18T00:00:00.000Z',
      });
    }

    const result = matchEventToExistingCases(getAdapter(), {
      event_id: 'event-status-filter',
      event_text: 'Status filter.',
      event_entities: ['entity_status', 'entity_project'],
      observed_at: '2026-04-18T00:00:00.000Z',
    });

    expect(result).toEqual([]);
  });
});
