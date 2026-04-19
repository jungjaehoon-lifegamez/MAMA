/**
 * Entity audit metric helpers.
 *
 * Pure functions — no DB, no embeddings. The audit queue assembles the
 * snapshot from live tables and fixtures, then hands it to these helpers
 * for deterministic metric calculation + baseline classification.
 */

export const FALSE_MERGE_HARD_CEILING = 0.02;

export type EntityAuditClassification = 'improved' | 'stable' | 'regressed' | 'inconclusive';

export interface AuditCandidateSnapshot {
  id: string;
  status: 'pending' | 'auto_merged' | 'approved' | 'rejected' | 'deferred';
  score_total: number;
  left_canonical_id: string | null;
  right_canonical_id: string | null;
  left_kind: string | null;
  right_kind: string | null;
}

export interface AuditGoldPair {
  canonical_id: string;
  left_obs_id: string;
  right_obs_id: string;
}

export interface AuditCandidateGoldLink {
  candidate_id: string;
  matched_pair_key: string;
  score_total: number;
}

export interface AuditSnapshot {
  candidates: AuditCandidateSnapshot[];
  gold_pairs: AuditGoldPair[];
  candidate_gold_matches: AuditCandidateGoldLink[];
  gold_canonical_projection_counts: Record<string, number>;
}

export interface AuditMetricSummary {
  false_merge_rate: number;
  false_merge_numerator: number;
  false_merge_denominator: number;
  cross_language_candidate_recall_at_10: number;
  cross_language_recall_numerator: number;
  cross_language_recall_denominator: number;
  ontology_violation_count: number;
  projection_fragmentation_rate: number;
}

export interface AuditRunClassificationInput {
  current: AuditMetricSummary;
  baseline: AuditMetricSummary | null;
}

const RESOLVED_MERGE_STATUSES = new Set<AuditCandidateSnapshot['status']>([
  'auto_merged',
  'approved',
]);

export function computeFalseMergeRate(candidates: AuditCandidateSnapshot[]): {
  rate: number;
  numerator: number;
  denominator: number;
} {
  let denominator = 0;
  let numerator = 0;
  for (const candidate of candidates) {
    if (!RESOLVED_MERGE_STATUSES.has(candidate.status)) continue;
    denominator += 1;
    if (
      candidate.left_canonical_id &&
      candidate.right_canonical_id &&
      candidate.left_canonical_id !== candidate.right_canonical_id
    ) {
      numerator += 1;
    }
  }
  const rate = denominator === 0 ? 0 : numerator / denominator;
  return { rate, numerator, denominator };
}

export function computeCrossLanguageRecallAtK(
  goldPairs: AuditGoldPair[],
  matches: AuditCandidateGoldLink[],
  k: number
): { recall: number; numerator: number; denominator: number } {
  const denominator = goldPairs.length;
  if (denominator === 0) {
    return { recall: 0, numerator: 0, denominator: 0 };
  }
  const topRanked = [...matches]
    .sort((a, b) => b.score_total - a.score_total)
    .slice(0, Math.max(0, k))
    .map((m) => m.matched_pair_key);
  const matched = new Set(topRanked);
  let numerator = 0;
  for (const pair of goldPairs) {
    const key = `${pair.canonical_id}:${pair.left_obs_id}:${pair.right_obs_id}`;
    if (matched.has(key)) numerator += 1;
  }
  return { recall: numerator / denominator, numerator, denominator };
}

export function computeCrossLanguageRecallAt5(
  goldPairs: AuditGoldPair[],
  matches: AuditCandidateGoldLink[]
): { recall: number; numerator: number; denominator: number } {
  return computeCrossLanguageRecallAtK(goldPairs, matches, 5);
}

export function computeCrossLanguageRecallAt10(
  goldPairs: AuditGoldPair[],
  matches: AuditCandidateGoldLink[]
): { recall: number; numerator: number; denominator: number } {
  return computeCrossLanguageRecallAtK(goldPairs, matches, 10);
}

export function computeOntologyViolationCount(candidates: AuditCandidateSnapshot[]): number {
  let count = 0;
  for (const candidate of candidates) {
    if (
      candidate.left_kind &&
      candidate.right_kind &&
      candidate.left_kind !== candidate.right_kind
    ) {
      count += 1;
    }
  }
  return count;
}

export function computeProjectionFragmentationRate(counts: Record<string, number>): number {
  const keys = Object.keys(counts);
  if (keys.length === 0) return 0;
  let fragmented = 0;
  for (const key of keys) {
    if ((counts[key] ?? 0) > 1) fragmented += 1;
  }
  return fragmented / keys.length;
}

export function computeAuditMetrics(snapshot: AuditSnapshot): AuditMetricSummary {
  const falseMerge = computeFalseMergeRate(snapshot.candidates);
  const recall = computeCrossLanguageRecallAt10(
    snapshot.gold_pairs,
    snapshot.candidate_gold_matches
  );
  const ontology = computeOntologyViolationCount(snapshot.candidates);
  const fragmentation = computeProjectionFragmentationRate(
    snapshot.gold_canonical_projection_counts
  );

  return {
    false_merge_rate: falseMerge.rate,
    false_merge_numerator: falseMerge.numerator,
    false_merge_denominator: falseMerge.denominator,
    cross_language_candidate_recall_at_10: recall.recall,
    cross_language_recall_numerator: recall.numerator,
    cross_language_recall_denominator: recall.denominator,
    ontology_violation_count: ontology,
    projection_fragmentation_rate: fragmentation,
  };
}

export function classifyAuditRun(input: AuditRunClassificationInput): EntityAuditClassification {
  const { current, baseline } = input;

  if (current.false_merge_rate > FALSE_MERGE_HARD_CEILING) {
    return 'regressed';
  }

  if (!baseline) {
    return 'inconclusive';
  }

  if (current.false_merge_rate > baseline.false_merge_rate) {
    return 'regressed';
  }

  const recallUp =
    current.cross_language_candidate_recall_at_10 > baseline.cross_language_candidate_recall_at_10;
  const fragmentationDown =
    current.projection_fragmentation_rate < baseline.projection_fragmentation_rate;
  const ontologyDown = current.ontology_violation_count < baseline.ontology_violation_count;

  if (recallUp || fragmentationDown || ontologyDown) {
    const anyRegression =
      current.cross_language_candidate_recall_at_10 <
        baseline.cross_language_candidate_recall_at_10 ||
      current.projection_fragmentation_rate > baseline.projection_fragmentation_rate ||
      current.ontology_violation_count > baseline.ontology_violation_count;
    if (anyRegression) return 'stable';
    return 'improved';
  }

  return 'stable';
}
