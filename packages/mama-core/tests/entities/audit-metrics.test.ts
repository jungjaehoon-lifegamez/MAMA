import { describe, expect, it } from 'vitest';
import {
  classifyAuditRun,
  computeAuditMetrics,
  computeCrossLanguageRecallAt5,
  computeCrossLanguageRecallAt10,
  computeCrossLanguageRecallAtK,
  computeFalseMergeRate,
  computeOntologyViolationCount,
  computeProjectionFragmentationRate,
  FALSE_MERGE_HARD_CEILING,
  type AuditCandidateSnapshot,
  type AuditGoldPair,
  type AuditMetricSummary,
} from '../../src/entities/audit-metrics.js';

function candidate(overrides: Partial<AuditCandidateSnapshot> = {}): AuditCandidateSnapshot {
  return {
    id: 'cand_test',
    status: 'approved',
    score_total: 0.9,
    left_canonical_id: 'gold_a',
    right_canonical_id: 'gold_a',
    left_kind: 'project',
    right_kind: 'project',
    ...overrides,
  };
}

describe('entity audit metrics', () => {
  describe('false_merge_rate', () => {
    it('is zero when no merges have resolved', () => {
      const result = computeFalseMergeRate([candidate({ status: 'pending', score_total: 0.5 })]);
      expect(result.rate).toBe(0);
      expect(result.denominator).toBe(0);
    });

    it('counts cross-group resolved merges as false merges', () => {
      const result = computeFalseMergeRate([
        candidate({ id: 'c1', status: 'approved' }),
        candidate({ id: 'c2', status: 'auto_merged', right_canonical_id: 'gold_b' }),
        candidate({ id: 'c3', status: 'rejected', right_canonical_id: 'gold_b' }),
      ]);
      expect(result.denominator).toBe(2);
      expect(result.numerator).toBe(1);
      expect(result.rate).toBeCloseTo(0.5);
    });
  });

  describe('cross_language_candidate_recall@10', () => {
    it('returns 0 when no gold pairs', () => {
      const result = computeCrossLanguageRecallAt10([], []);
      expect(result.recall).toBe(0);
    });

    it('scores only gold pairs that appear in the top 1 when k=1', () => {
      const gold: AuditGoldPair[] = [
        { canonical_id: 'gold_a', left_obs_id: 'o1', right_obs_id: 'o2' },
        { canonical_id: 'gold_b', left_obs_id: 'o3', right_obs_id: 'o4' },
      ];
      const matches = [
        { candidate_id: 'c1', matched_pair_key: 'gold_a:o1:o2', score_total: 0.99 },
        { candidate_id: 'c2', matched_pair_key: 'gold_b:o3:o4', score_total: 0.01 },
      ];
      const result = computeCrossLanguageRecallAtK(gold, matches, 1);
      expect(result.denominator).toBe(2);
      expect(result.numerator).toBe(1);
      expect(result.recall).toBe(0.5);
    });

    it('scores only gold pairs that appear in the top 10', () => {
      const gold: AuditGoldPair[] = [
        { canonical_id: 'gold_a', left_obs_id: 'o1', right_obs_id: 'o2' },
        { canonical_id: 'gold_b', left_obs_id: 'o3', right_obs_id: 'o4' },
      ];
      const matches = [
        { candidate_id: 'c1', matched_pair_key: 'gold_a:o1:o2', score_total: 0.99 },
        { candidate_id: 'c2', matched_pair_key: 'gold_b:o3:o4', score_total: 0.01 },
      ];
      const result = computeCrossLanguageRecallAt10(gold, matches);
      expect(result.denominator).toBe(2);
      expect(result.numerator).toBe(2);
      expect(result.recall).toBe(1);
    });

    it('exposes a @5 convenience wrapper without changing the @10 result', () => {
      const gold: AuditGoldPair[] = [
        { canonical_id: 'gold_a', left_obs_id: 'o1', right_obs_id: 'o2' },
      ];
      const matches = [{ candidate_id: 'c1', matched_pair_key: 'gold_a:o1:o2', score_total: 0.42 }];

      expect(computeCrossLanguageRecallAt5(gold, matches).recall).toBe(1);
      expect(computeCrossLanguageRecallAt10(gold, matches).recall).toBe(1);
    });
  });

  describe('ontology_violation_count', () => {
    it('counts candidates with mismatched left/right kinds', () => {
      const count = computeOntologyViolationCount([
        candidate({ left_kind: 'project', right_kind: 'person' }),
        candidate({ left_kind: 'project', right_kind: 'project' }),
        candidate({ left_kind: 'organization', right_kind: 'work_item' }),
      ]);
      expect(count).toBe(2);
    });
  });

  describe('projection_fragmentation_rate', () => {
    it('is the share of gold canonicals with >1 projected entity', () => {
      const rate = computeProjectionFragmentationRate({
        gold_a: 1,
        gold_b: 3,
        gold_c: 2,
        gold_d: 1,
      });
      expect(rate).toBeCloseTo(0.5);
    });

    it('is zero for empty input', () => {
      expect(computeProjectionFragmentationRate({})).toBe(0);
    });
  });

  describe('computeAuditMetrics', () => {
    it('assembles a full summary from a snapshot', () => {
      const summary = computeAuditMetrics({
        candidates: [
          candidate({ id: 'c1', status: 'approved' }),
          candidate({ id: 'c2', status: 'auto_merged', right_canonical_id: 'gold_b' }),
        ],
        gold_pairs: [{ canonical_id: 'gold_a', left_obs_id: 'o1', right_obs_id: 'o2' }],
        candidate_gold_matches: [
          { candidate_id: 'c1', matched_pair_key: 'gold_a:o1:o2', score_total: 0.92 },
        ],
        gold_canonical_projection_counts: { gold_a: 1, gold_b: 2 },
      });
      expect(summary.false_merge_rate).toBeCloseTo(0.5);
      expect(summary.cross_language_candidate_recall_at_10).toBe(1);
      expect(summary.projection_fragmentation_rate).toBe(0.5);
    });
  });

  describe('classifyAuditRun', () => {
    const base: AuditMetricSummary = {
      false_merge_rate: 0,
      false_merge_numerator: 0,
      false_merge_denominator: 10,
      cross_language_candidate_recall_at_10: 0.5,
      cross_language_recall_numerator: 5,
      cross_language_recall_denominator: 10,
      ontology_violation_count: 2,
      projection_fragmentation_rate: 0.2,
    };

    it('is regressed when false_merge_rate exceeds the hard ceiling regardless of baseline', () => {
      const cls = classifyAuditRun({
        current: { ...base, false_merge_rate: FALSE_MERGE_HARD_CEILING + 0.01 },
        baseline: base,
      });
      expect(cls).toBe('regressed');
    });

    it('is inconclusive when no baseline is available', () => {
      const cls = classifyAuditRun({ current: base, baseline: null });
      expect(cls).toBe('inconclusive');
    });

    it('is improved when every tracked soft metric improved and none regressed', () => {
      const cls = classifyAuditRun({
        current: {
          ...base,
          cross_language_candidate_recall_at_10: 0.6,
          projection_fragmentation_rate: 0.1,
          ontology_violation_count: 1,
        },
        baseline: base,
      });
      expect(cls).toBe('improved');
    });

    it('is regressed when false_merge_rate is worse than baseline', () => {
      const cls = classifyAuditRun({
        current: { ...base, false_merge_rate: 0.01 },
        baseline: { ...base, false_merge_rate: 0.005 },
      });
      expect(cls).toBe('regressed');
    });

    it('is stable when movement is mixed', () => {
      const cls = classifyAuditRun({
        current: {
          ...base,
          cross_language_candidate_recall_at_10: 0.6,
          projection_fragmentation_rate: 0.3,
        },
        baseline: base,
      });
      expect(cls).toBe('stable');
    });
  });
});
