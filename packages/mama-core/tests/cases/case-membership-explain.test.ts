import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJSON } from '../../src/canonicalize.js';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  explainCaseMembership,
  populateScoreBreakdown,
} from '../../src/cases/membership-explain.js';

function resetCaseTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM case_links').run();
  adapter.prepare('DELETE FROM case_corrections').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_truth').run();
}

function insertCase(
  overrides: Partial<{
    case_id: string;
    title: string;
    status: string;
    canonical_case_id: string | null;
  }>
): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (case_id, title, status, canonical_case_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      overrides.title ?? overrides.case_id,
      overrides.status ?? 'active',
      overrides.canonical_case_id ?? null,
      now,
      now
    );
}

function insertMembership(input: {
  case_id: string;
  source_type?: 'decision' | 'event' | 'observation' | 'artifact';
  source_id: string;
  score_breakdown_json?: string | null;
  source_locator?: string | null;
  assignment_strategy?: string | null;
}): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status,
          added_by, added_at, updated_at, user_locked, assignment_strategy,
          score_breakdown_json, source_locator, explanation_updated_at
        )
        VALUES (?, ?, ?, 'evidence', 0.88, 'matched', 'active', 'memory-agent',
                ?, ?, 0, ?, ?, ?, ?)
      `
    )
    .run(
      input.case_id,
      input.source_type ?? 'decision',
      input.source_id,
      now,
      now,
      input.assignment_strategy ?? null,
      input.score_breakdown_json ?? null,
      input.source_locator ?? null,
      input.score_breakdown_json === undefined ? null : now
    );
}

describe('Task 16: Membership explanation core helper', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-membership-explain');
  });

  beforeEach(() => {
    resetCaseTables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('explanation returns score_breakdown when stored', () => {
    insertCase({ case_id: 'case-explained' });
    insertMembership({
      case_id: 'case-explained',
      source_id: 'dec-explained',
      assignment_strategy: 'memory-agent-match',
      score_breakdown_json: canonicalizeJSON({
        entity_overlap: 0.8,
        embedding_similarity: 0.7,
        temporal_proximity: 0.6,
        explicit_from_wiki: 0,
      }),
      source_locator: 'decision://dec-explained',
    });

    const result = explainCaseMembership(getAdapter(), {
      case_id: 'case-explained',
      source_type: 'decision',
      source_id: 'dec-explained',
    });

    expect(result).toMatchObject({
      case_id: 'case-explained',
      terminal_case_id: 'case-explained',
      resolved_via_case_id: null,
      chain: ['case-explained'],
      score_breakdown: {
        entity_overlap: 0.8,
        embedding_similarity: 0.7,
        temporal_proximity: 0.6,
        explicit_from_wiki: 0,
      },
      source_locator: 'decision://dec-explained',
      warnings: [],
    });
  });

  it('explanation returns null breakdown and reason when not stored', () => {
    insertCase({ case_id: 'case-legacy' });
    insertMembership({
      case_id: 'case-legacy',
      source_id: 'dec-legacy',
    });

    const result = explainCaseMembership(getAdapter(), {
      case_id: 'case-legacy',
      source_type: 'decision',
      source_id: 'dec-legacy',
    });

    expect(result).toMatchObject({
      score_breakdown: null,
      score_breakdown_reason: 'breakdown_not_recorded',
      warnings: ['breakdown_not_recorded'],
    });
  });

  it('chain resolution finds a membership on a merged loser case', () => {
    insertCase({ case_id: 'case-survivor' });
    insertCase({
      case_id: 'case-loser',
      status: 'merged',
      canonical_case_id: 'case-survivor',
    });
    insertMembership({
      case_id: 'case-loser',
      source_type: 'event',
      source_id: 'evt-loser',
      score_breakdown_json: canonicalizeJSON({
        entity_overlap: 1,
        embedding_similarity: 0.4,
        temporal_proximity: 0.9,
        explicit_from_wiki: 0,
      }),
      source_locator: 'event://evt-loser',
    });

    const result = explainCaseMembership(getAdapter(), {
      case_id: 'case-survivor',
      source_type: 'event',
      source_id: 'evt-loser',
    });

    expect(result).toMatchObject({
      case_id: 'case-loser',
      terminal_case_id: 'case-survivor',
      chain: ['case-survivor', 'case-loser'],
      source_locator: 'event://evt-loser',
    });
  });

  it('is deterministic and performs no query-time LLM call', () => {
    insertCase({ case_id: 'case-deterministic' });
    insertMembership({
      case_id: 'case-deterministic',
      source_id: 'dec-deterministic',
      score_breakdown_json: canonicalizeJSON({
        entity_overlap: 0.3,
        embedding_similarity: 0.2,
        temporal_proximity: 0.1,
        explicit_from_wiki: 1,
      }),
      source_locator: 'decision://dec-deterministic',
    });

    const first = explainCaseMembership(getAdapter(), {
      case_id: 'case-deterministic',
      source_type: 'decision',
      source_id: 'dec-deterministic',
    });
    const second = explainCaseMembership(getAdapter(), {
      case_id: 'case-deterministic',
      source_type: 'decision',
      source_id: 'dec-deterministic',
    });

    expect(second).toEqual(first);
  });

  it('source_locator round-trips through populateScoreBreakdown', () => {
    insertCase({ case_id: 'case-populate' });
    insertMembership({
      case_id: 'case-populate',
      source_type: 'observation',
      source_id: 'obs-populate',
    });

    const populated = populateScoreBreakdown(
      getAdapter(),
      {
        case_id: 'case-populate',
        source_type: 'observation',
        source_id: 'obs-populate',
        assignment_strategy: 'memory-agent-match',
        source_locator: 'obsidian://Cases/Alpha.md#evidence',
        now: '2026-04-18T01:00:00.000Z',
      },
      {
        entity_overlap: 0.5,
        embedding_similarity: 0.6,
        temporal_proximity: 0.7,
        explicit_from_wiki: 0,
      }
    );

    expect(populated).toEqual({ kind: 'populated', changes: 1 });

    const result = explainCaseMembership(getAdapter(), {
      case_id: 'case-populate',
      source_type: 'observation',
      source_id: 'obs-populate',
    });

    expect(result).toMatchObject({
      source_locator: 'obsidian://Cases/Alpha.md#evidence',
      membership: {
        assignment_strategy: 'memory-agent-match',
      },
      score_breakdown: {
        entity_overlap: 0.5,
        embedding_similarity: 0.6,
        temporal_proximity: 0.7,
        explicit_from_wiki: 0,
      },
    });
  });
});
