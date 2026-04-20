import type { DatabaseAdapter } from '../db-manager.js';
import { vectorSearchWikiPages } from './wiki-page-index.js';

export interface CaseMembershipMatchInput {
  event_id: string;
  event_text: string;
  event_entities: string[];
  observed_at: string;
  explicit_case_id?: string | null;
  query_embedding?: Float32Array | null;
  now?: string;
}

export interface CaseMembershipMatch {
  case_id: string;
  score: number;
  status: 'active' | 'candidate';
  reason: string;
}

export type CaseMembershipMatchResult =
  | CaseMembershipMatch[]
  | { kind: 'precompile_gap'; code: 'case.precompile_gap'; case_id: string };

type MatcherAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

interface ExplicitCaseRow {
  case_id: string;
  status: string;
}

interface CandidateCaseRow {
  case_id: string;
  title: string;
  primary_actors: string | null;
  current_wiki_path: string | null;
  last_activity_at: string | null;
  compiled_at: string | null;
  status: string;
  confidence: string | null;
}

const ACTIVE_CASE_STATUSES = new Set(['active', 'blocked']);
const ACTIVE_THRESHOLD = 0.7;
const CANDIDATE_THRESHOLD = 0.52;
const RECENCY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeEntity(value: string): string {
  return value.trim().toLowerCase();
}

function parsePrimaryActors(value: string | null): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  const actorIds: string[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      actorIds.push(item);
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const entityId = (item as { entity_id?: unknown }).entity_id;
      if (typeof entityId === 'string' && entityId.trim().length > 0) {
        actorIds.push(entityId);
      }
    }
  }

  return actorIds;
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right.map(normalizeEntity).filter(Boolean));
  const seen = new Set<string>();
  let count = 0;

  for (const value of left) {
    const normalized = normalizeEntity(value);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (rightSet.has(normalized)) {
      count += 1;
    }
  }

  return count;
}

function timestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasRecentActivity(row: CandidateCaseRow, observedAt: string): boolean {
  const observedMs = timestampMs(observedAt);
  if (observedMs === null) {
    return false;
  }

  const caseMs = timestampMs(row.last_activity_at) ?? timestampMs(row.compiled_at);
  if (caseMs === null) {
    return false;
  }

  return Math.abs(observedMs - caseMs) <= RECENCY_WINDOW_MS;
}

function wikiSimilarityByCase(
  adapter: MatcherAdapter,
  queryEmbedding?: Float32Array | null
): Map<string, number> {
  const scores = new Map<string, number>();
  if (!queryEmbedding) {
    return scores;
  }

  try {
    const hits = vectorSearchWikiPages(adapter, queryEmbedding, 20);
    for (const hit of hits) {
      if (hit.record.page_type !== 'case' || !hit.record.case_id) {
        continue;
      }
      const existing = scores.get(hit.record.case_id) ?? -Infinity;
      if (hit.raw_score > existing) {
        scores.set(hit.record.case_id, hit.raw_score);
      }
    }
  } catch {
    return scores;
  }

  return scores;
}

function scoreCandidate(input: {
  row: CandidateCaseRow;
  eventEntities: string[];
  observedAt: string;
  wikiScore: number;
}): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  const actorOverlap = overlapCount(
    input.eventEntities,
    parsePrimaryActors(input.row.primary_actors)
  );
  if (actorOverlap > 0) {
    const actorScore = Math.min(0.45 * actorOverlap, 0.9);
    score += actorScore;
    signals.push(`primary_actors_overlap:${actorOverlap}`);
  }

  if (input.wikiScore >= 0.82) {
    score += 0.3;
    signals.push(`wiki_embedding:${input.wikiScore.toFixed(3)}`);
  } else if (input.wikiScore >= 0.74) {
    score += 0.18;
    signals.push(`wiki_embedding:${input.wikiScore.toFixed(3)}`);
  }

  if (hasRecentActivity(input.row, input.observedAt)) {
    score += 0.15;
    signals.push('recent_activity');
  }

  return { score, signals };
}

function toMatch(case_id: string, score: number, signals: string[]): CaseMembershipMatch | null {
  if (score >= ACTIVE_THRESHOLD) {
    return {
      case_id,
      score: Number(score.toFixed(4)),
      status: 'active',
      reason: signals.join(','),
    };
  }

  if (score >= CANDIDATE_THRESHOLD) {
    return {
      case_id,
      score: Number(score.toFixed(4)),
      status: 'candidate',
      reason: signals.join(','),
    };
  }

  return null;
}

export function matchEventToExistingCases(
  adapter: DatabaseAdapter,
  input: CaseMembershipMatchInput
): CaseMembershipMatchResult {
  const matcherAdapter = adapter as unknown as MatcherAdapter;

  if (input.explicit_case_id) {
    const row = matcherAdapter
      .prepare(
        `
          SELECT case_id, status
          FROM case_truth
          WHERE case_id = ?
        `
      )
      .get(input.explicit_case_id) as ExplicitCaseRow | undefined;

    if (!row) {
      return {
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: input.explicit_case_id,
      };
    }

    if (!ACTIVE_CASE_STATUSES.has(row.status)) {
      return [];
    }

    return [
      {
        case_id: row.case_id,
        score: 1,
        status: 'active',
        reason: 'explicit_case_id',
      },
    ];
  }

  const rows = matcherAdapter
    .prepare(
      `
        SELECT case_id, title, primary_actors, current_wiki_path, last_activity_at,
               compiled_at, status, confidence
        FROM case_truth
        WHERE status IN ('active','blocked')
        ORDER BY COALESCE(last_activity_at, compiled_at, created_at) DESC
        LIMIT 200
      `
    )
    .all() as CandidateCaseRow[];

  const wikiScores = wikiSimilarityByCase(matcherAdapter, input.query_embedding);

  const matches: CaseMembershipMatch[] = [];
  for (const row of rows) {
    const { score, signals } = scoreCandidate({
      row,
      eventEntities: input.event_entities,
      observedAt: input.observed_at,
      wikiScore: wikiScores.get(row.case_id) ?? 0,
    });

    const match = toMatch(row.case_id, score, signals);
    if (match) {
      matches.push(match);
    }
  }

  return matches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.case_id.localeCompare(right.case_id);
  });
}
