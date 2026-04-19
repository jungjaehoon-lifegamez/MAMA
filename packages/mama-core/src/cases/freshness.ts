import { randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { runImmediateTransaction, type ImmediateTransactionAdapter } from './sqlite-transaction.js';
import { resolveCanonicalCaseChain } from './store.js';
import type { CanonicalCaseResolution } from './types.js';

export type CaseFreshnessState = 'fresh' | 'stale' | 'drifted' | 'unknown';

export interface CaseFreshnessReason {
  code:
    | 'missing_compile'
    | 'activity_after_compile'
    | 'state_update_after_compile'
    | 'wiki_index_missing'
    | 'timestamps_absent';
  penalty: number;
  detail?: string;
}

export interface CaseFreshnessCalculation {
  freshness_score: number;
  freshness_state: CaseFreshnessState;
  freshness_score_is_drifted: 0 | 1;
  freshness_drift_threshold: number;
  reasons: CaseFreshnessReason[];
  freshness_reason_json: string;
}

export interface CaseFreshnessResult extends CaseFreshnessCalculation {
  case_id: string;
  terminal_case_id: string;
  resolved_via_case_id: string | null;
  chain: string[];
  freshness_checked_at: string;
  changed: boolean;
}

export interface SweepCaseFreshnessInput {
  case_ids?: string[];
  now?: string;
  drift_threshold?: number;
}

export interface SweepCaseFreshnessResult {
  checked: number;
  fresh: number;
  stale: number;
  drifted: number;
  drifted_case_ids: string[];
  results: CaseFreshnessResult[];
  rejected?: Array<{ case_id: string; code: 'case.terminal_status'; message: string }>;
}

type FreshnessAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'> &
  Partial<Pick<ImmediateTransactionAdapter, 'exec'>>;

interface CaseFreshnessRow {
  case_id: string;
  status: string;
  current_wiki_path: string | null;
  last_activity_at: string | null;
  state_updated_at: string | null;
  compiled_at: string | null;
  freshness_score: number | null;
  freshness_state: CaseFreshnessState | null;
  freshness_score_is_drifted: number;
  freshness_drift_threshold: number | null;
  freshness_checked_at: string | null;
  freshness_reason_json: string | null;
}

const DEFAULT_DRIFT_THRESHOLD = 0.5;
const TERMINAL_CASE_STATUSES = new Set(['merged', 'archived', 'split']);

function normalizeNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function createdAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedThreshold(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_DRIFT_THRESHOLD;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('freshness drift_threshold must be between 0 and 1.');
  }
  return Number(value.toFixed(4));
}

function score(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

function resolveChain(adapter: FreshnessAdapter, caseId: string): CanonicalCaseResolution | null {
  try {
    return resolveCanonicalCaseChain(adapter, caseId);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function expandCaseChainForAssembly(
  adapter: FreshnessAdapter,
  terminalCaseId: string,
  resolvedChain: string[]
): string[] {
  const rows = adapter
    .prepare(
      `
        WITH RECURSIVE merged_chain(case_id, depth) AS (
          SELECT case_id, 0
            FROM case_truth
           WHERE case_id = ?

          UNION

          SELECT ct.case_id, merged_chain.depth + 1
            FROM case_truth ct
            JOIN merged_chain ON ct.canonical_case_id = merged_chain.case_id
           WHERE merged_chain.depth < 64
        )
        SELECT case_id
          FROM merged_chain
         ORDER BY depth ASC, case_id ASC
      `
    )
    .all(terminalCaseId) as Array<{ case_id: string }>;

  const chain: string[] = [];
  for (const caseId of [...resolvedChain, ...rows.map((row) => row.case_id)]) {
    if (!chain.includes(caseId)) {
      chain.push(caseId);
    }
  }
  return chain;
}

function loadCase(adapter: FreshnessAdapter, caseId: string): CaseFreshnessRow | null {
  const row = adapter
    .prepare(
      `
        SELECT case_id, status, current_wiki_path, last_activity_at, state_updated_at,
               compiled_at, freshness_score, freshness_state, freshness_score_is_drifted,
               freshness_drift_threshold, freshness_checked_at, freshness_reason_json
        FROM case_truth
        WHERE case_id = ?
      `
    )
    .get(caseId) as CaseFreshnessRow | undefined;

  return row ?? null;
}

function wikiIndexUpdatedAt(adapter: FreshnessAdapter, caseId: string): string | null {
  const row = adapter
    .prepare(
      `
        SELECT updated_at
        FROM wiki_page_index
        WHERE case_id = ?
          AND page_type = 'case'
        ORDER BY updated_at DESC, page_id ASC
        LIMIT 1
      `
    )
    .get(caseId) as { updated_at: string } | undefined;

  return row?.updated_at ?? null;
}

function allCandidateCaseIds(adapter: FreshnessAdapter): string[] {
  const rows = adapter
    .prepare(
      `
        SELECT case_id
        FROM case_truth
        WHERE status NOT IN ('merged','archived','split')
        ORDER BY case_id ASC
      `
    )
    .all() as Array<{ case_id: string }>;

  return rows.map((row) => row.case_id);
}

function insertDriftEvent(input: {
  adapter: FreshnessAdapter;
  case_id: string;
  result: CaseFreshnessCalculation;
  now: string;
}): void {
  input.adapter
    .prepare(
      `
        INSERT INTO memory_events (
          event_id, event_type, actor, source_turn_id, memory_id, topic,
          scope_refs, evidence_refs, reason, created_at
        )
        VALUES (?, 'case.freshness_drifted', 'system', NULL, NULL, ?, ?, ?, ?, ?)
      `
    )
    .run(
      `me_${randomUUID()}`,
      `case:${input.case_id}`,
      canonicalizeJSON([{ type: 'case', id: input.case_id }]),
      canonicalizeJSON([input.case_id]),
      canonicalizeJSON({
        freshness_score: input.result.freshness_score,
        freshness_drift_threshold: input.result.freshness_drift_threshold,
        reasons: input.result.reasons,
      }),
      createdAtMs(input.now)
    );
}

function hasFreshnessChanged(row: CaseFreshnessRow, result: CaseFreshnessCalculation): boolean {
  return (
    row.freshness_score !== result.freshness_score ||
    row.freshness_state !== result.freshness_state ||
    Number(row.freshness_score_is_drifted) !== result.freshness_score_is_drifted ||
    row.freshness_drift_threshold !== result.freshness_drift_threshold ||
    row.freshness_reason_json !== result.freshness_reason_json
  );
}

export function calculateCaseFreshness(input: {
  last_activity_at?: string | null;
  state_updated_at?: string | null;
  compiled_at?: string | null;
  wiki_index_updated_at?: string | null;
  current_wiki_path?: string | null;
  drift_threshold?: number;
  now?: string;
}): CaseFreshnessCalculation {
  const threshold = normalizedThreshold(input.drift_threshold);
  const reasons: CaseFreshnessReason[] = [];
  let value = 1.0;

  const compiledMs = timestampMs(input.compiled_at);
  const activityMs = timestampMs(input.last_activity_at);
  const stateUpdatedMs = timestampMs(input.state_updated_at);
  const wikiUpdatedMs = timestampMs(input.wiki_index_updated_at);
  const hasWikiPath = Boolean(input.current_wiki_path && input.current_wiki_path.trim().length > 0);

  if (compiledMs === null) {
    value -= 0.5;
    reasons.push({ code: 'missing_compile', penalty: 0.5 });
  }

  if (activityMs !== null && compiledMs !== null && activityMs > compiledMs) {
    value -= 0.35;
    reasons.push({ code: 'activity_after_compile', penalty: 0.35 });
  }

  if (stateUpdatedMs !== null && compiledMs !== null && stateUpdatedMs > compiledMs) {
    value -= 0.25;
    reasons.push({ code: 'state_update_after_compile', penalty: 0.25 });
  }

  if (hasWikiPath && wikiUpdatedMs === null) {
    value -= 0.25;
    reasons.push({
      code: 'wiki_index_missing',
      penalty: 0.25,
      detail: input.current_wiki_path ?? '',
    });
  }

  const timestampsAbsent = compiledMs === null && activityMs === null && stateUpdatedMs === null;
  if (timestampsAbsent) {
    reasons.push({ code: 'timestamps_absent', penalty: 0 });
  }

  const freshnessScore = score(value);
  let state: CaseFreshnessState;
  if (timestampsAbsent) {
    state = 'unknown';
  } else if (freshnessScore >= 0.8) {
    state = 'fresh';
  } else if (freshnessScore < threshold) {
    state = 'drifted';
  } else {
    state = 'stale';
  }

  const result = {
    freshness_score: freshnessScore,
    freshness_state: state,
    freshness_score_is_drifted: state === 'drifted' ? 1 : 0,
    freshness_drift_threshold: threshold,
    reasons,
    freshness_reason_json: canonicalizeJSON(reasons),
  } satisfies CaseFreshnessCalculation;

  return result;
}

export function sweepCaseFreshness(
  adapter: DatabaseAdapter,
  input: SweepCaseFreshnessInput = {}
): SweepCaseFreshnessResult {
  const freshnessAdapter = adapter as unknown as FreshnessAdapter;

  return runImmediateTransaction(freshnessAdapter, () => {
    const now = normalizeNow(input.now);
    const requestedCaseIds = input.case_ids ?? allCandidateCaseIds(freshnessAdapter);
    const seenTerminalIds = new Set<string>();
    const results: CaseFreshnessResult[] = [];
    const rejected: Array<{ case_id: string; code: 'case.terminal_status'; message: string }> = [];

    for (const requestedCaseId of requestedCaseIds) {
      const resolution = resolveChain(freshnessAdapter, requestedCaseId);
      if (!resolution) {
        continue;
      }

      if (seenTerminalIds.has(resolution.terminal_case_id)) {
        continue;
      }

      const row = loadCase(freshnessAdapter, resolution.terminal_case_id);
      if (!row) {
        continue;
      }

      if (TERMINAL_CASE_STATUSES.has(row.status)) {
        if (input.case_ids && input.case_ids.length === 1) {
          rejected.push({
            case_id: requestedCaseId,
            code: 'case.terminal_status',
            message: `Freshness cannot be written to terminal case status ${row.status}.`,
          });
        }
        continue;
      }

      seenTerminalIds.add(resolution.terminal_case_id);
      const chain = expandCaseChainForAssembly(
        freshnessAdapter,
        resolution.terminal_case_id,
        resolution.chain
      );
      const calculation = calculateCaseFreshness({
        last_activity_at: row.last_activity_at,
        state_updated_at: row.state_updated_at,
        compiled_at: row.compiled_at,
        wiki_index_updated_at: wikiIndexUpdatedAt(freshnessAdapter, resolution.terminal_case_id),
        current_wiki_path: row.current_wiki_path,
        drift_threshold: input.drift_threshold,
        now,
      });
      const changed = hasFreshnessChanged(row, calculation);
      const driftedTransition =
        changed && row.freshness_state !== 'drifted' && calculation.freshness_state === 'drifted';

      if (changed) {
        freshnessAdapter
          .prepare(
            `
              UPDATE case_truth
              SET freshness_score = ?,
                  freshness_state = ?,
                  freshness_score_is_drifted = ?,
                  freshness_drift_threshold = ?,
                  freshness_checked_at = ?,
                  freshness_reason_json = ?
              WHERE case_id = ?
            `
          )
          .run(
            calculation.freshness_score,
            calculation.freshness_state,
            calculation.freshness_score_is_drifted,
            calculation.freshness_drift_threshold,
            now,
            calculation.freshness_reason_json,
            resolution.terminal_case_id
          );

        if (driftedTransition) {
          insertDriftEvent({
            adapter: freshnessAdapter,
            case_id: resolution.terminal_case_id,
            result: calculation,
            now,
          });
        }
      }

      results.push({
        case_id: requestedCaseId,
        terminal_case_id: resolution.terminal_case_id,
        resolved_via_case_id: resolution.resolved_via_case_id,
        chain,
        freshness_checked_at: changed
          ? now
          : ((row as { freshness_checked_at?: string | null }).freshness_checked_at ?? now),
        changed,
        ...calculation,
      });
    }

    return {
      checked: results.length,
      fresh: results.filter((result) => result.freshness_state === 'fresh').length,
      stale: results.filter((result) => result.freshness_state === 'stale').length,
      drifted: results.filter((result) => result.freshness_state === 'drifted').length,
      drifted_case_ids: results
        .filter((result) => result.freshness_state === 'drifted')
        .map((result) => result.terminal_case_id),
      results,
      ...(rejected.length > 0 ? { rejected } : {}),
    };
  });
}

export function listDriftedCases(
  adapter: DatabaseAdapter
): Array<{ case_id: string; freshness_score: number; freshness_checked_at: string | null }> {
  const rows = adapter
    .prepare(
      `
        SELECT case_id, freshness_score, freshness_checked_at
        FROM case_truth
        WHERE freshness_state = 'drifted'
          AND freshness_score_is_drifted = 1
        ORDER BY freshness_score ASC, case_id ASC
      `
    )
    .all() as Array<{
    case_id: string;
    freshness_score: number;
    freshness_checked_at: string | null;
  }>;

  return rows;
}
