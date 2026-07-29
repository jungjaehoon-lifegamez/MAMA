import type { RunResult } from '../db-adapter/statement.js';
import {
  extractFeatures,
  featureSetVersion as currentFeatureSetVersion,
  SEARCH_RANKER_FEATURE_SET_VERSION,
  serializeFeatures,
} from './ranker-features.js';
import { type QuestionType } from './question-type.js';

export interface SearchRankerModel {
  model_id: string;
  feature_set_version: string;
  trained_at: string;
  training_rows_count: number;
  coefficients: number[];
  intercept: number;
  question_type_weights: Record<QuestionType, number[]>;
  training_window?: EffectiveTrainingWindow;
}

export interface RankerTrainerInput {
  adapter: RankerTrainerAdapter;
  since?: string;
  until?: string;
  minFeedbackRows?: number;
  minDistinctQueries?: number;
  featureSetVersion?: string;
  now?: Date;
}

export interface EffectiveTrainingWindow {
  since: string;
  until: string;
  retention_cutoff_at: string;
  retention_days_at_train_time: number;
  retention_warning: boolean;
}

export interface TrainOfflineRankerResult {
  status: 'trained' | 'insufficient_data';
  model?: SearchRankerModel;
  effectiveWindow: EffectiveTrainingWindow;
  counts: {
    feedbackRows: number;
    distinctQueries: number;
  };
}

export interface BaselineMetrics {
  ndcg: number;
  mrr: number;
  per_query: Record<string, { ndcg: number; mrr: number }>;
}

export interface RankerEvaluation {
  bm25: BaselineMetrics;
  vector: BaselineMetrics;
  rrf: BaselineMetrics;
  logistic: BaselineMetrics;
  learned: BaselineMetrics;
  passes: boolean;
}

export interface RankerTrainerAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction?<T>(fn: () => T): T | (() => T);
}

interface QualityCandidate {
  id: string;
  source_type: string;
  bm25_score: number;
  vector_score: number;
  case_rollup_score: number;
  recency_score: number;
  relevance: number;
}

interface QualityFixture {
  query: string;
  question_type: QuestionType;
  candidates: QualityCandidate[];
}

// 0.01 is a small but meaningful margin across 8 fixture queries: it blocks
// tie/noise wins without demanding a large jump on a tiny evaluation set.

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    const current = shuffled[index]!;
    shuffled[index] = shuffled[swapIndex]!;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function reorderFixtureCandidates(
  query: string,
  candidates: readonly QualityCandidate[]
): QualityCandidate[] {
  if (candidates.length <= 1) {
    return [...candidates];
  }

  const seed = Array.from(query).reduce((total, char) => total + char.charCodeAt(0), 0);
  return seededShuffle(candidates, seed);
}

const RAW_RANKER_QUALITY_FIXTURES: readonly QualityFixture[] = [
  {
    query: 'fix the stale case status correction',
    question_type: 'correction',
    candidates: [
      {
        id: 'correction-good-1',
        source_type: 'decision',
        bm25_score: 0.18,
        vector_score: 0.25,
        case_rollup_score: 0.3,
        recency_score: 0.4,
        relevance: 3,
      },
      {
        id: 'correction-bad-1',
        source_type: 'wiki_page',
        bm25_score: 0.95,
        vector_score: 0.86,
        case_rollup_score: 0.2,
        recency_score: 0.2,
        relevance: 0,
      },
      {
        id: 'correction-mid-1',
        source_type: 'case',
        bm25_score: 0.45,
        vector_score: 0.42,
        case_rollup_score: 0.35,
        recency_score: 0.1,
        relevance: 1,
      },
      {
        id: 'correction-bad-2',
        source_type: 'connector_event',
        bm25_score: 0.74,
        vector_score: 0.71,
        case_rollup_score: 0.25,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'correction-bad-3',
        source_type: 'checkpoint',
        bm25_score: 0.61,
        vector_score: 0.67,
        case_rollup_score: 0.15,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
  {
    query: 'revert the mistaken merge decision',
    question_type: 'correction',
    candidates: [
      {
        id: 'correction-good-2',
        source_type: 'decision',
        bm25_score: 0.22,
        vector_score: 0.2,
        case_rollup_score: 0.33,
        recency_score: 0.2,
        relevance: 3,
      },
      {
        id: 'correction-bad-4',
        source_type: 'connector_event',
        bm25_score: 0.92,
        vector_score: 0.88,
        case_rollup_score: 0.2,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'correction-mid-2',
        source_type: 'case',
        bm25_score: 0.5,
        vector_score: 0.49,
        case_rollup_score: 0.38,
        recency_score: 0.1,
        relevance: 1,
      },
      {
        id: 'correction-bad-5',
        source_type: 'wiki_page',
        bm25_score: 0.7,
        vector_score: 0.76,
        case_rollup_score: 0.2,
        recency_score: 0.2,
        relevance: 0,
      },
      {
        id: 'correction-bad-6',
        source_type: 'checkpoint',
        bm25_score: 0.6,
        vector_score: 0.57,
        case_rollup_score: 0.19,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
  {
    query: 'find the Obsidian doc for the case',
    question_type: 'artifact',
    candidates: [
      {
        id: 'artifact-good-1',
        source_type: 'wiki_page',
        bm25_score: 0.21,
        vector_score: 0.28,
        case_rollup_score: 0.3,
        recency_score: 0.2,
        relevance: 3,
      },
      {
        id: 'artifact-bad-1',
        source_type: 'decision',
        bm25_score: 0.96,
        vector_score: 0.87,
        case_rollup_score: 0.21,
        recency_score: 0.4,
        relevance: 0,
      },
      {
        id: 'artifact-mid-1',
        source_type: 'case',
        bm25_score: 0.44,
        vector_score: 0.47,
        case_rollup_score: 0.36,
        recency_score: 0.2,
        relevance: 1,
      },
      {
        id: 'artifact-bad-2',
        source_type: 'connector_event',
        bm25_score: 0.73,
        vector_score: 0.74,
        case_rollup_score: 0.18,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'artifact-bad-3',
        source_type: 'checkpoint',
        bm25_score: 0.68,
        vector_score: 0.62,
        case_rollup_score: 0.19,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
  {
    query: 'which pdf described the rollout',
    question_type: 'artifact',
    candidates: [
      {
        id: 'artifact-good-2',
        source_type: 'wiki_page',
        bm25_score: 0.19,
        vector_score: 0.26,
        case_rollup_score: 0.31,
        recency_score: 0.2,
        relevance: 3,
      },
      {
        id: 'artifact-bad-4',
        source_type: 'decision',
        bm25_score: 0.91,
        vector_score: 0.89,
        case_rollup_score: 0.21,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'artifact-mid-2',
        source_type: 'case',
        bm25_score: 0.49,
        vector_score: 0.43,
        case_rollup_score: 0.35,
        recency_score: 0.3,
        relevance: 1,
      },
      {
        id: 'artifact-bad-5',
        source_type: 'connector_event',
        bm25_score: 0.76,
        vector_score: 0.72,
        case_rollup_score: 0.2,
        recency_score: 0.2,
        relevance: 0,
      },
      {
        id: 'artifact-bad-6',
        source_type: 'checkpoint',
        bm25_score: 0.63,
        vector_score: 0.61,
        case_rollup_score: 0.19,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
  {
    query: 'when did the blocker first happen',
    question_type: 'timeline',
    candidates: [
      {
        id: 'timeline-good-1',
        source_type: 'connector_event',
        bm25_score: 0.2,
        vector_score: 0.29,
        case_rollup_score: 0.3,
        recency_score: 0.2,
        relevance: 3,
      },
      {
        id: 'timeline-bad-1',
        source_type: 'decision',
        bm25_score: 0.93,
        vector_score: 0.91,
        case_rollup_score: 0.18,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'timeline-mid-1',
        source_type: 'checkpoint',
        bm25_score: 0.48,
        vector_score: 0.46,
        case_rollup_score: 0.34,
        recency_score: 0.2,
        relevance: 1,
      },
      {
        id: 'timeline-bad-2',
        source_type: 'case',
        bm25_score: 0.78,
        vector_score: 0.74,
        case_rollup_score: 0.18,
        recency_score: 0.2,
        relevance: 0,
      },
      {
        id: 'timeline-bad-3',
        source_type: 'wiki_page',
        bm25_score: 0.64,
        vector_score: 0.63,
        case_rollup_score: 0.19,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
  {
    query: 'history before the regression',
    question_type: 'timeline',
    candidates: [
      {
        id: 'timeline-good-2',
        source_type: 'connector_event',
        bm25_score: 0.23,
        vector_score: 0.27,
        case_rollup_score: 0.31,
        recency_score: 0.2,
        relevance: 3,
      },
      {
        id: 'timeline-bad-4',
        source_type: 'decision',
        bm25_score: 0.94,
        vector_score: 0.9,
        case_rollup_score: 0.18,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'timeline-mid-2',
        source_type: 'checkpoint',
        bm25_score: 0.47,
        vector_score: 0.45,
        case_rollup_score: 0.36,
        recency_score: 0.2,
        relevance: 1,
      },
      {
        id: 'timeline-bad-5',
        source_type: 'case',
        bm25_score: 0.75,
        vector_score: 0.77,
        case_rollup_score: 0.19,
        recency_score: 0.2,
        relevance: 0,
      },
      {
        id: 'timeline-bad-6',
        source_type: 'wiki_page',
        bm25_score: 0.62,
        vector_score: 0.64,
        case_rollup_score: 0.18,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
  {
    query: 'current status of the rollout',
    question_type: 'status',
    candidates: [
      {
        id: 'status-good-1',
        source_type: 'case',
        bm25_score: 0.2,
        vector_score: 0.24,
        case_rollup_score: 0.36,
        recency_score: 0.2,
        relevance: 3,
      },
      {
        id: 'status-bad-1',
        source_type: 'decision',
        bm25_score: 0.97,
        vector_score: 0.9,
        case_rollup_score: 0.2,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'status-mid-1',
        source_type: 'checkpoint',
        bm25_score: 0.46,
        vector_score: 0.47,
        case_rollup_score: 0.34,
        recency_score: 0.2,
        relevance: 1,
      },
      {
        id: 'status-bad-2',
        source_type: 'connector_event',
        bm25_score: 0.74,
        vector_score: 0.73,
        case_rollup_score: 0.19,
        recency_score: 0.2,
        relevance: 0,
      },
      {
        id: 'status-bad-3',
        source_type: 'wiki_page',
        bm25_score: 0.65,
        vector_score: 0.62,
        case_rollup_score: 0.18,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
  {
    query: 'latest progress on case assembly',
    question_type: 'status',
    candidates: [
      {
        id: 'status-good-2',
        source_type: 'case',
        bm25_score: 0.22,
        vector_score: 0.23,
        case_rollup_score: 0.37,
        recency_score: 0.2,
        relevance: 3,
      },
      {
        id: 'status-bad-4',
        source_type: 'decision',
        bm25_score: 0.92,
        vector_score: 0.91,
        case_rollup_score: 0.2,
        recency_score: 0.3,
        relevance: 0,
      },
      {
        id: 'status-mid-2',
        source_type: 'checkpoint',
        bm25_score: 0.48,
        vector_score: 0.45,
        case_rollup_score: 0.34,
        recency_score: 0.2,
        relevance: 1,
      },
      {
        id: 'status-bad-5',
        source_type: 'connector_event',
        bm25_score: 0.77,
        vector_score: 0.75,
        case_rollup_score: 0.2,
        recency_score: 0.2,
        relevance: 0,
      },
      {
        id: 'status-bad-6',
        source_type: 'wiki_page',
        bm25_score: 0.66,
        vector_score: 0.63,
        case_rollup_score: 0.18,
        recency_score: 0.2,
        relevance: 0,
      },
    ],
  },
];

export const RANKER_QUALITY_FIXTURES: readonly QualityFixture[] = RAW_RANKER_QUALITY_FIXTURES.map(
  (fixture) => ({
    ...fixture,
    candidates: reorderFixtureCandidates(fixture.query, fixture.candidates),
  })
);

function sigmoid(value: number): number {
  if (value >= 35) {
    return 1;
  }
  if (value <= -35) {
    return 0;
  }
  return 1 / (1 + Math.exp(-value));
}

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += left[index] * right[index];
  }
  return total;
}

export function scoreWithRankerModel(
  model: SearchRankerModel,
  row: Record<string, unknown>,
  query: string,
  questionType: QuestionType
): number {
  const features = serializeFeatures(extractFeatures(row, query, { question_type: questionType }));
  const coefficients = model.question_type_weights[questionType] ?? model.coefficients;
  return sigmoid(dot(coefficients, features) + model.intercept);
}

export function ndcgAtK<T extends { id: string }>(
  results: readonly T[],
  relevanceMap: Map<string, number>,
  k: number
): number {
  const gains = results.slice(0, k).map((result, index) => {
    const relevance = relevanceMap.get(result.id) ?? 0;
    return (2 ** relevance - 1) / Math.log2(index + 2);
  });
  const dcg = gains.reduce((sum, gain) => sum + gain, 0);
  const ideal = Array.from(relevanceMap.values())
    .sort((left, right) => right - left)
    .slice(0, k)
    .map((relevance, index) => (2 ** relevance - 1) / Math.log2(index + 2))
    .reduce((sum, gain) => sum + gain, 0);

  return ideal === 0 ? 0 : dcg / ideal;
}

export function mrr<T extends { id: string }>(
  results: readonly T[],
  relevantSet: Set<string>
): number {
  const index = results.findIndex((result) => relevantSet.has(result.id));
  return index === -1 ? 0 : 1 / (index + 1);
}

export { SEARCH_RANKER_FEATURE_SET_VERSION, currentFeatureSetVersion as featureSetVersion };
