import { randomBytes } from 'node:crypto';
import type { RunResult } from '../db-adapter/statement.js';
import {
  getFeedbackRetentionDays,
  listSearchFeedback,
  type SearchFeedbackRow,
} from './feedback-store.js';
import {
  extractFeatures,
  featureSetVersion as currentFeatureSetVersion,
  SEARCH_RANKER_FEATURE_SET_VERSION,
  serializeFeatures,
} from './ranker-features.js';
import { QUESTION_TYPES, type QuestionType } from './question-type.js';

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

interface TrainingExample {
  query: string;
  question_type: QuestionType;
  features: number[];
  label: number;
  feedback_kind: SearchFeedbackRow['feedback_kind'];
  created_at: string;
  feedback_id: string;
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LEARNING_RATE = 0.05;
const MINI_BATCH_SIZE = 32;
const MAX_EPOCHS = 500;
const EARLY_STOP_DELTA = 1e-5;

function reorderFixtureCandidates(
  query: string,
  candidates: readonly QualityCandidate[]
): QualityCandidate[] {
  if (candidates.length <= 1) {
    return [...candidates];
  }

  const offset =
    Array.from(query).reduce((total, char) => total + char.charCodeAt(0), 0) % candidates.length;
  return candidates.map((_, index) => candidates[(index + offset) % candidates.length]!);
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

function asSourceForFeedback(
  sourceType: string
): 'decision' | 'checkpoint' | 'wiki_page' | 'case' | 'connector_event' {
  switch (sourceType) {
    case 'wiki_page':
      return 'wiki_page';
    case 'case':
      return 'case';
    case 'connector_event':
      return 'connector_event';
    case 'checkpoint':
      return 'checkpoint';
    default:
      return 'decision';
  }
}

function parseDate(input: string, field: string): Date {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid ISO timestamp`);
  }
  return date;
}

function iso(date: Date): string {
  return date.toISOString();
}

function effectiveWindow(input: RankerTrainerInput): EffectiveTrainingWindow {
  const retentionDays = getFeedbackRetentionDays(input.adapter);
  const now = input.now ?? new Date();
  const retentionCutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
  const until = input.until ? parseDate(input.until, 'until') : now;
  const since = input.since ? parseDate(input.since, 'since') : retentionCutoff;

  if (since.getTime() > until.getTime()) {
    throw new Error('since must be before until');
  }

  const retentionWarning = Boolean(input.since && since.getTime() < retentionCutoff.getTime());
  if (retentionWarning) {
    console.warn(
      JSON.stringify({
        event: 'training_window_exceeds_retention',
        since: iso(since),
        retention_cutoff_at: iso(retentionCutoff),
      })
    );
  }

  return {
    since: iso(since),
    until: iso(until),
    retention_cutoff_at: iso(retentionCutoff),
    retention_days_at_train_time: retentionDays,
    retention_warning: retentionWarning,
  };
}

function labelForKind(kind: SearchFeedbackRow['feedback_kind']): number | null {
  if (kind === 'accept' || kind === 'click') {
    return 1;
  }
  if (kind === 'reject' || kind === 'hide' || kind === 'shown') {
    return 0;
  }
  return null;
}

function rowToExample(row: SearchFeedbackRow): TrainingExample | null {
  const label = labelForKind(row.feedback_kind);
  if (label === null) {
    return null;
  }

  const features = serializeFeatures(
    extractFeatures(
      {
        ...row,
        source_type: row.result_source_type,
        rank_position: row.rank_position,
      },
      row.query,
      { question_type: row.question_type }
    )
  );

  return {
    query: row.query,
    question_type: row.question_type,
    features,
    label,
    feedback_kind: row.feedback_kind,
    created_at: row.created_at,
    feedback_id: row.feedback_id,
  };
}

function capNeutralRows(rows: SearchFeedbackRow[]): SearchFeedbackRow[] {
  const byQuery = new Map<string, SearchFeedbackRow[]>();
  for (const row of rows) {
    const key = row.query_hash_hex || row.query;
    const current = byQuery.get(key) ?? [];
    current.push(row);
    byQuery.set(key, current);
  }

  const capped: SearchFeedbackRow[] = [];
  for (const groupRows of byQuery.values()) {
    const explicit = groupRows.filter((row) => row.feedback_kind !== 'shown');
    const shown = groupRows.filter((row) => row.feedback_kind === 'shown');
    const neutralLimit = explicit.length * 3;
    capped.push(...explicit, ...shown.slice(0, neutralLimit));
  }

  capped.sort((left, right) => {
    const byCreatedAt = left.created_at.localeCompare(right.created_at);
    return byCreatedAt !== 0 ? byCreatedAt : left.feedback_id.localeCompare(right.feedback_id);
  });

  return capped;
}

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

function hasBothLabels(examples: TrainingExample[]): boolean {
  const labels = new Set(examples.map((example) => example.label));
  return labels.has(0) && labels.has(1);
}

function trainWeights(
  examples: TrainingExample[],
  featureCount: number
): { coefficients: number[]; intercept: number } {
  const coefficients = new Array(featureCount).fill(0);
  let intercept = 0;

  if (examples.length === 0 || !hasBothLabels(examples)) {
    return { coefficients, intercept };
  }

  for (let epoch = 0; epoch < MAX_EPOCHS; epoch += 1) {
    let epochDelta = 0;
    let batchCount = 0;

    for (let batchStart = 0; batchStart < examples.length; batchStart += MINI_BATCH_SIZE) {
      const batch = examples.slice(batchStart, batchStart + MINI_BATCH_SIZE);
      const gradients = new Array(featureCount).fill(0);
      let interceptGradient = 0;

      for (const example of batch) {
        const prediction = sigmoid(dot(coefficients, example.features) + intercept);
        const error = prediction - example.label;
        for (let index = 0; index < featureCount; index += 1) {
          gradients[index] += error * example.features[index];
        }
        interceptGradient += error;
      }

      let delta = 0;
      for (let index = 0; index < featureCount; index += 1) {
        const update = (LEARNING_RATE * gradients[index]) / batch.length;
        coefficients[index] -= update;
        delta += Math.abs(update);
      }

      const interceptUpdate = (LEARNING_RATE * interceptGradient) / batch.length;
      intercept -= interceptUpdate;
      delta += Math.abs(interceptUpdate);

      epochDelta += delta;
      batchCount += 1;
    }

    if (batchCount > 0 && epochDelta / batchCount < EARLY_STOP_DELTA) {
      break;
    }
  }

  return { coefficients, intercept };
}

function questionWeights(
  examples: TrainingExample[],
  featureCount: number,
  fallback: number[]
): Record<QuestionType, number[]> {
  const output = {} as Record<QuestionType, number[]>;

  for (const questionType of QUESTION_TYPES) {
    const subset = examples.filter((example) => example.question_type === questionType);
    output[questionType] = hasBothLabels(subset)
      ? trainWeights(subset, featureCount).coefficients
      : [...fallback];
  }

  return output;
}

function modelIdFor(input: { trainedAt: string; rows: number; distinctQueries: number }): string {
  const compactTime = input.trainedAt.replace(/[^0-9]/g, '').slice(0, 17);
  const uniqueSuffix = randomBytes(4).toString('hex');
  return `ranker_${compactTime}_${input.rows}_${input.distinctQueries}_${uniqueSuffix}`;
}

export async function trainOfflineRanker(
  input: RankerTrainerInput
): Promise<TrainOfflineRankerResult> {
  const minFeedbackRows = input.minFeedbackRows ?? 1000;
  const minDistinctQueries = input.minDistinctQueries ?? 10;
  const window = effectiveWindow(input);
  const rows = listSearchFeedback(input.adapter, {
    since: window.since,
    until: window.until,
  });
  const cappedRows = capNeutralRows(rows);
  const examples = cappedRows
    .map(rowToExample)
    .filter((example): example is TrainingExample => Boolean(example));
  const distinctQueries = new Set(examples.map((example) => example.query.trim().toLowerCase()))
    .size;
  const counts = {
    feedbackRows: examples.length,
    distinctQueries,
  };
  const examplesHaveBothLabels = hasBothLabels(examples);

  if (
    counts.feedbackRows < minFeedbackRows ||
    counts.distinctQueries < minDistinctQueries ||
    !examplesHaveBothLabels
  ) {
    return {
      status: 'insufficient_data',
      effectiveWindow: window,
      counts,
    };
  }

  const featureCount =
    examples[0]?.features.length ?? serializeFeatures(extractFeatures({}, '')).length;
  const trained = trainWeights(examples, featureCount);
  const trainedAt = input.now ? input.now.toISOString() : new Date().toISOString();
  const model: SearchRankerModel = {
    model_id: modelIdFor({
      trainedAt,
      rows: counts.feedbackRows,
      distinctQueries: counts.distinctQueries,
    }),
    feature_set_version: input.featureSetVersion ?? currentFeatureSetVersion(),
    trained_at: trainedAt,
    training_rows_count: examples.length,
    coefficients: trained.coefficients,
    intercept: trained.intercept,
    question_type_weights: questionWeights(examples, featureCount, trained.coefficients),
    training_window: window,
  };

  return {
    status: 'trained',
    model,
    effectiveWindow: window,
    counts,
  };
}

function rankByScore<T extends { id: string }>(items: T[], score: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((left, right) => {
      const diff = right.score - left.score;
      if (Math.abs(diff) > 1e-12) {
        return diff;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

function reciprocalRankRanks<T extends { id: string }>(
  items: T[],
  leftScore: (item: T) => number,
  rightScore: (item: T) => number
): T[] {
  const left = rankByScore(items, leftScore);
  const right = rankByScore(items, rightScore);
  const leftRanks = new Map(left.map((item, index) => [item.id, index + 1]));
  const rightRanks = new Map(right.map((item, index) => [item.id, index + 1]));

  return rankByScore(items, (item) => {
    const leftRank = leftRanks.get(item.id) ?? items.length;
    const rightRank = rightRanks.get(item.id) ?? items.length;
    return 1 / (60 + leftRank) + 1 / (60 + rightRank);
  });
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

function baselineMetrics(
  fixtures: readonly QualityFixture[],
  ranker: (fixture: QualityFixture) => QualityCandidate[]
): BaselineMetrics {
  const perQuery: Record<string, { ndcg: number; mrr: number }> = {};
  let ndcgTotal = 0;
  let mrrTotal = 0;

  for (const fixture of fixtures) {
    const ranked = ranker(fixture);
    const relevance = new Map(
      fixture.candidates.map((candidate) => [candidate.id, candidate.relevance])
    );
    const relevantSet = new Set(
      fixture.candidates
        .filter((candidate) => candidate.relevance > 0)
        .map((candidate) => candidate.id)
    );
    const ndcg = ndcgAtK(ranked, relevance, 5);
    const mrrScore = mrr(ranked, relevantSet);
    perQuery[fixture.query] = { ndcg, mrr: mrrScore };
    ndcgTotal += ndcg;
    mrrTotal += mrrScore;
  }

  return {
    ndcg: ndcgTotal / fixtures.length,
    mrr: mrrTotal / fixtures.length,
    per_query: perQuery,
  };
}

export async function evaluateAgainstBaselines(
  _input: RankerTrainerInput,
  model: SearchRankerModel
): Promise<RankerEvaluation> {
  const bm25 = baselineMetrics(RANKER_QUALITY_FIXTURES, (fixture) =>
    rankByScore(fixture.candidates, (candidate) => candidate.bm25_score)
  );
  const vector = baselineMetrics(RANKER_QUALITY_FIXTURES, (fixture) =>
    rankByScore(fixture.candidates, (candidate) => candidate.vector_score)
  );
  const rrf = baselineMetrics(RANKER_QUALITY_FIXTURES, (fixture) =>
    reciprocalRankRanks(
      fixture.candidates,
      (candidate) => candidate.bm25_score,
      (candidate) => candidate.vector_score
    )
  );
  const logistic = baselineMetrics(RANKER_QUALITY_FIXTURES, (fixture) =>
    rankByScore(
      fixture.candidates,
      (candidate) => 0.5 * candidate.bm25_score + 0.5 * candidate.vector_score
    )
  );
  const learned = baselineMetrics(RANKER_QUALITY_FIXTURES, (fixture) =>
    rankByScore(fixture.candidates, (candidate) =>
      scoreWithRankerModel(
        model,
        candidate as unknown as Record<string, unknown>,
        fixture.query,
        fixture.question_type
      )
    )
  );

  const bestBaselineNdcg = Math.max(bm25.ndcg, vector.ndcg, rrf.ndcg, logistic.ndcg);
  const bestBaselineMrr = Math.max(bm25.mrr, vector.mrr, rrf.mrr, logistic.mrr);

  return {
    bm25,
    vector,
    rrf,
    logistic,
    learned,
    passes: learned.ndcg >= bestBaselineNdcg + 0.01 && learned.mrr >= bestBaselineMrr + 0.01,
  };
}

function runTransaction<T>(adapter: RankerTrainerAdapter, fn: () => T): T {
  if (!adapter.transaction) {
    return fn();
  }

  const result = adapter.transaction(fn);
  if (typeof result === 'function') {
    return (result as () => T)();
  }
  return result;
}

export async function insertRankerModelVersion(
  adapter: RankerTrainerAdapter,
  model: SearchRankerModel,
  evaluation: RankerEvaluation
): Promise<{ model_id: string; active: boolean }> {
  const coefficientsPayload = JSON.stringify({
    coefficients: model.coefficients,
    intercept: model.intercept,
    question_type_weights: model.question_type_weights,
    training_rows_count: model.training_rows_count,
  });
  const metricsPayload = JSON.stringify({
    learned: evaluation.learned,
    passes: evaluation.passes,
  });
  const baselinePayload = JSON.stringify({
    bm25: evaluation.bm25,
    vector: evaluation.vector,
    rrf: evaluation.rrf,
    logistic: evaluation.logistic,
  });
  const trainingWindowPayload = JSON.stringify(
    model.training_window ?? {
      since: null,
      until: null,
      retention_cutoff_at: null,
      retention_days_at_train_time: null,
      retention_warning: false,
    }
  );

  adapter
    .prepare(
      `
        INSERT INTO ranker_model_versions (
          model_id, model_version, feature_set_version, coefficients_json, metrics_json,
          training_window_json, baseline_metrics_json, quality_gate_status, trained_at,
          trained_by, active
        )
        VALUES (?, 'offline-logistic-v1', ?, ?, ?, ?, ?, ?, ?, 'mama train-ranker', 0)
      `
    )
    .run(
      model.model_id,
      model.feature_set_version,
      coefficientsPayload,
      metricsPayload,
      trainingWindowPayload,
      baselinePayload,
      evaluation.passes ? 'passed' : 'failed',
      model.trained_at
    );

  return { model_id: model.model_id, active: false };
}

export async function activateRankerModel(
  adapter: RankerTrainerAdapter,
  model_id: string
): Promise<'activated' | 'quality_gate_failed' | 'feature_set_mismatch' | 'not_found'> {
  const row = adapter
    .prepare(
      `
        SELECT model_id, feature_set_version, quality_gate_status
        FROM ranker_model_versions
        WHERE model_id = ?
      `
    )
    .get(model_id) as
    | {
        model_id: string;
        feature_set_version: string;
        quality_gate_status: string;
      }
    | undefined;

  if (!row) {
    return 'not_found';
  }
  if (row.feature_set_version !== SEARCH_RANKER_FEATURE_SET_VERSION) {
    return 'feature_set_mismatch';
  }
  if (row.quality_gate_status !== 'passed') {
    return 'quality_gate_failed';
  }

  runTransaction(adapter, () => {
    adapter.prepare('UPDATE ranker_model_versions SET active = 0 WHERE active = 1').run();
    adapter.prepare('UPDATE ranker_model_versions SET active = 1 WHERE model_id = ?').run(model_id);
  });

  return 'activated';
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

export function seedQualityFixtureFeedback(
  adapter: RankerTrainerAdapter,
  createdAt = '2026-04-18T00:00:00.000Z'
): void {
  let counter = 0;
  for (const fixture of RANKER_QUALITY_FIXTURES) {
    for (const candidate of fixture.candidates) {
      counter += 1;
      const kind = candidate.relevance >= 3 ? 'accept' : 'reject';
      adapter
        .prepare(
          `
            INSERT INTO search_feedback (
              feedback_id, query, query_hash, question_type, result_source_type, result_source_id,
              case_id, feedback_kind, rank_position, score_before, score_after, session_id,
              actor, metadata_json, created_at, updated_at
            )
            VALUES (?, ?, zeroblob(32), ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 'test:ranker-fixture', '{}', ?, NULL)
          `
        )
        .run(
          `quality-${counter}`,
          fixture.query,
          fixture.question_type,
          asSourceForFeedback(candidate.source_type),
          candidate.id,
          kind,
          counter % 5,
          `fixture:${fixture.question_type}`,
          createdAt
        );
    }
  }
}

export { SEARCH_RANKER_FEATURE_SET_VERSION, currentFeatureSetVersion as featureSetVersion };
