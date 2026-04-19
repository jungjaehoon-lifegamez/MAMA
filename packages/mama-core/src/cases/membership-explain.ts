import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { expandCaseChainForAssembly, resolveCanonicalCaseChain } from './store.js';
import type { CaseMembershipSourceType } from './types.js';

export interface CaseMembershipScoreBreakdown {
  entity_overlap: number | null;
  embedding_similarity: number | null;
  temporal_proximity: number | null;
  explicit_from_wiki: number | null;
}

export interface CaseMembershipExplanation {
  case_id: string;
  terminal_case_id: string;
  resolved_via_case_id: string | null;
  chain: string[];
  source_type: CaseMembershipSourceType;
  source_id: string;
  membership: {
    status: string;
    role: string | null;
    confidence: number | null;
    reason: string | null;
    user_locked: boolean;
    assignment_strategy: string | null;
    assigned_at: string | null;
  };
  score_breakdown: CaseMembershipScoreBreakdown | null;
  score_breakdown_reason?: 'breakdown_not_recorded' | 'breakdown_malformed';
  source_locator: string | null;
  explanation_updated_at: string | null;
  warnings: string[];
}

export interface PopulateScoreBreakdownInput {
  case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  assignment_strategy?: string | null;
  source_locator?: string | null;
  now?: string;
}

export type ExplainCaseMembershipResult =
  | CaseMembershipExplanation
  | {
      kind: 'not_found';
      code: 'case.membership_not_found';
      message: string;
      terminal_case_id: string;
      resolved_via_case_id: string | null;
      chain: string[];
    };

type MembershipExplainAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

interface MembershipExplainRow {
  case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  status: string;
  role: string | null;
  confidence: number | null;
  reason: string | null;
  user_locked: number;
  assignment_strategy: string | null;
  assigned_at: string | null;
  score_breakdown_json: string | null;
  source_locator: string | null;
  explanation_updated_at: string | null;
  updated_at: string;
}

function normalizeNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL IN clause for an empty value list.');
  }
  return values.map(() => '?').join(', ');
}

function loadMembership(
  adapter: MembershipExplainAdapter,
  chain: string[],
  sourceType: CaseMembershipSourceType,
  sourceId: string
): MembershipExplainRow | null {
  const row = adapter
    .prepare(
      `
        SELECT case_id, source_type, source_id, status, role, confidence, reason,
               user_locked, assignment_strategy, added_at AS assigned_at,
               score_breakdown_json, source_locator, explanation_updated_at, updated_at
        FROM case_memberships
        WHERE case_id IN (${placeholders(chain)})
          AND source_type = ?
          AND source_id = ?
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'candidate' THEN 1
            WHEN 'excluded' THEN 2
            WHEN 'removed' THEN 3
            ELSE 4
          END ASC,
          user_locked DESC,
          updated_at DESC,
          case_id ASC
        LIMIT 1
      `
    )
    .get(...chain, sourceType, sourceId) as MembershipExplainRow | undefined;

  return row ?? null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseScoreBreakdown(value: string | null): {
  breakdown: CaseMembershipScoreBreakdown | null;
  reason?: 'breakdown_not_recorded' | 'breakdown_malformed';
  warnings: string[];
} {
  if (value === null || value.trim().length === 0) {
    return {
      breakdown: null,
      reason: 'breakdown_not_recorded',
      warnings: ['breakdown_not_recorded'],
    };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        breakdown: null,
        reason: 'breakdown_malformed',
        warnings: ['breakdown_malformed'],
      };
    }

    const record = parsed as Record<string, unknown>;
    return {
      breakdown: {
        entity_overlap: nullableNumber(record.entity_overlap),
        embedding_similarity: nullableNumber(record.embedding_similarity),
        temporal_proximity: nullableNumber(record.temporal_proximity),
        explicit_from_wiki: nullableNumber(record.explicit_from_wiki),
      },
      warnings: [],
    };
  } catch {
    return {
      breakdown: null,
      reason: 'breakdown_malformed',
      warnings: ['breakdown_malformed'],
    };
  }
}

export function explainCaseMembership(
  adapter: DatabaseAdapter,
  input: { case_id: string; source_type: CaseMembershipSourceType; source_id: string }
): ExplainCaseMembershipResult {
  const explainAdapter = adapter as unknown as MembershipExplainAdapter;
  const resolution = resolveCanonicalCaseChain(explainAdapter, input.case_id);
  const chain = expandCaseChainForAssembly(
    explainAdapter,
    resolution.terminal_case_id,
    resolution.chain
  );
  const row = loadMembership(explainAdapter, chain, input.source_type, input.source_id);

  if (!row) {
    return {
      kind: 'not_found',
      code: 'case.membership_not_found',
      message: 'Membership row was not found in the canonical case chain.',
      terminal_case_id: resolution.terminal_case_id,
      resolved_via_case_id: resolution.resolved_via_case_id,
      chain,
    };
  }

  const parsedBreakdown = parseScoreBreakdown(row.score_breakdown_json);

  return {
    case_id: row.case_id,
    terminal_case_id: resolution.terminal_case_id,
    resolved_via_case_id: resolution.resolved_via_case_id,
    chain,
    source_type: row.source_type,
    source_id: row.source_id,
    membership: {
      status: row.status,
      role: row.role,
      confidence: row.confidence,
      reason: row.reason,
      user_locked: Number(row.user_locked) === 1,
      assignment_strategy: row.assignment_strategy,
      assigned_at: row.assigned_at,
    },
    score_breakdown: parsedBreakdown.breakdown,
    ...(parsedBreakdown.reason ? { score_breakdown_reason: parsedBreakdown.reason } : {}),
    source_locator: row.source_locator,
    explanation_updated_at: row.explanation_updated_at,
    warnings: parsedBreakdown.warnings,
  };
}

export function populateScoreBreakdown(
  adapter: DatabaseAdapter,
  membershipRow: PopulateScoreBreakdownInput,
  breakdown: CaseMembershipScoreBreakdown
): { kind: 'populated'; changes: number } {
  const now = normalizeNow(membershipRow.now);
  const result = adapter
    .prepare(
      `
        UPDATE case_memberships
        SET score_breakdown_json = ?,
            source_locator = COALESCE(?, source_locator),
            assignment_strategy = COALESCE(?, assignment_strategy),
            explanation_updated_at = ?
        WHERE case_id = ?
          AND source_type = ?
          AND source_id = ?
      `
    )
    .run(
      canonicalizeJSON(breakdown),
      membershipRow.source_locator ?? null,
      membershipRow.assignment_strategy ?? null,
      now,
      membershipRow.case_id,
      membershipRow.source_type,
      membershipRow.source_id
    );

  return { kind: 'populated', changes: result.changes };
}
