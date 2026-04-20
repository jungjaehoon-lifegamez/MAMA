import type { RunResult } from '../db-adapter/statement.js';
import {
  SEARCH_RANKER_FEATURE_SET_VERSION,
  serializeFeatures,
  extractFeatures,
} from './ranker-features.js';
import { scoreWithRankerModel, type SearchRankerModel } from './ranker-trainer.js';
import { classifyQuestionType } from './question-type.js';

export type SearchRankerSkippedReason =
  | 'feature_disabled'
  | 'no_active_model'
  | 'feature_set_mismatch'
  | 'quality_gate_failed'
  | 'insufficient_result_count'
  | 'llm_reranking_requested';

export interface RankerRescoreAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface RankerScoredFields {
  ranker_score?: number;
  score_before_ranker?: number;
  final_score?: number;
}

export interface RescoreSearchResultsOptions<T> {
  query: string;
  results: T[];
  featureEnabled?: boolean;
  useReranking?: boolean;
}

export interface RescoreSearchResultsResult<T> {
  results: Array<T & RankerScoredFields>;
  model_id: string | null;
  skipped_reason?: SearchRankerSkippedReason;
}

interface RankerModelRow {
  model_id: string;
  feature_set_version: string;
  coefficients_json: string;
  quality_gate_status: 'passed' | 'failed' | 'not_run';
  trained_at: string;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : 0));
}

function parseQuestionWeights(
  value: unknown,
  fallback: number[]
): SearchRankerModel['question_type_weights'] {
  const object =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    correction:
      parseNumberArray(object.correction).length > 0
        ? parseNumberArray(object.correction)
        : [...fallback],
    artifact:
      parseNumberArray(object.artifact).length > 0
        ? parseNumberArray(object.artifact)
        : [...fallback],
    timeline:
      parseNumberArray(object.timeline).length > 0
        ? parseNumberArray(object.timeline)
        : [...fallback],
    status:
      parseNumberArray(object.status).length > 0 ? parseNumberArray(object.status) : [...fallback],
    decision_reason:
      parseNumberArray(object.decision_reason).length > 0
        ? parseNumberArray(object.decision_reason)
        : [...fallback],
    how_to:
      parseNumberArray(object.how_to).length > 0 ? parseNumberArray(object.how_to) : [...fallback],
    unknown:
      parseNumberArray(object.unknown).length > 0
        ? parseNumberArray(object.unknown)
        : [...fallback],
  };
}

function modelFromRow(row: RankerModelRow): SearchRankerModel {
  const payload = parseJsonObject(row.coefficients_json);
  const coefficients = parseNumberArray(payload.coefficients);
  const intercept = typeof payload.intercept === 'number' ? payload.intercept : 0;
  const trainingRowsCount =
    typeof payload.training_rows_count === 'number' ? payload.training_rows_count : 0;

  return {
    model_id: row.model_id,
    feature_set_version: row.feature_set_version,
    trained_at: row.trained_at,
    training_rows_count: trainingRowsCount,
    coefficients,
    intercept,
    question_type_weights: parseQuestionWeights(payload.question_type_weights, coefficients),
  };
}

function loadActiveRow(adapter: RankerRescoreAdapter): RankerModelRow | null {
  const row = adapter
    .prepare(
      `
        SELECT model_id, feature_set_version, coefficients_json, quality_gate_status, trained_at
        FROM ranker_model_versions
        WHERE active = 1
        ORDER BY trained_at DESC
        LIMIT 1
      `
    )
    .get() as RankerModelRow | undefined;

  return row ?? null;
}

function logSkipped(reason: SearchRankerSkippedReason, modelId: string | null): void {
  console.warn(
    JSON.stringify({
      event: 'search_ranker_skipped',
      skipped_reason: reason,
      model_id: modelId,
      feature_set_version: SEARCH_RANKER_FEATURE_SET_VERSION,
    })
  );
}

export function loadActiveSearchRankerModel(
  adapter: RankerRescoreAdapter
): SearchRankerModel | null {
  const row = loadActiveRow(adapter);
  if (!row) {
    return null;
  }

  if (row.feature_set_version !== SEARCH_RANKER_FEATURE_SET_VERSION) {
    logSkipped('feature_set_mismatch', row.model_id);
    return null;
  }

  return modelFromRow(row);
}

export function isSearchRankerEnabled(adapter: RankerRescoreAdapter): boolean {
  const row = adapter
    .prepare(
      `
        SELECT value_json
        FROM search_ranker_settings
        WHERE key = 'search_ranker_enabled'
      `
    )
    .get() as { value_json?: string } | undefined;

  if (!row?.value_json) {
    return true;
  }

  const parsed = JSON.parse(row.value_json) as unknown;
  return parsed !== false;
}

function baseScore(row: Record<string, unknown>): number {
  const candidates = [
    row.final_score,
    row.retrieval_score,
    row.score,
    row.similarity,
    row.confidence,
    row.case_rollup_score,
    row.vector_score,
    row.bm25_score,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return 0;
}

function resultId(row: Record<string, unknown>, fallback: number): string {
  const id = row.id ?? row.source_id ?? row.result_source_id;
  return id === undefined || id === null ? String(fallback) : String(id);
}

export function rescoreSearchResults<T extends Record<string, unknown>>(
  adapter: RankerRescoreAdapter,
  options: RescoreSearchResultsOptions<T>
): RescoreSearchResultsResult<T> {
  const passthrough = options.results as Array<T & RankerScoredFields>;

  if (options.useReranking) {
    return {
      results: passthrough,
      model_id: null,
      skipped_reason: 'llm_reranking_requested',
    };
  }

  if (options.featureEnabled === false) {
    return {
      results: passthrough,
      model_id: null,
      skipped_reason: 'feature_disabled',
    };
  }

  if (options.results.length < 2) {
    return {
      results: passthrough,
      model_id: null,
      skipped_reason: 'insufficient_result_count',
    };
  }

  const row = loadActiveRow(adapter);
  if (!row) {
    return {
      results: passthrough,
      model_id: null,
      skipped_reason: 'no_active_model',
    };
  }

  if (row.feature_set_version !== SEARCH_RANKER_FEATURE_SET_VERSION) {
    logSkipped('feature_set_mismatch', row.model_id);
    return {
      results: passthrough,
      model_id: row.model_id,
      skipped_reason: 'feature_set_mismatch',
    };
  }

  if (row.quality_gate_status === 'failed') {
    return {
      results: passthrough,
      model_id: row.model_id,
      skipped_reason: 'quality_gate_failed',
    };
  }

  if (row.quality_gate_status !== 'passed') {
    return {
      results: passthrough,
      model_id: row.model_id,
      skipped_reason: 'quality_gate_failed',
    };
  }

  const model = modelFromRow(row);
  const questionType = classifyQuestionType(options.query);
  const scored = options.results.map((result, index) => {
    const scoreBeforeRanker = baseScore(result);
    const rankerScore = scoreWithRankerModel(model, result, options.query, questionType);
    const finalScore = 0.8 * scoreBeforeRanker + 0.2 * rankerScore;

    return {
      result: {
        ...result,
        ranker_score: rankerScore,
        score_before_ranker: scoreBeforeRanker,
        final_score: finalScore,
      } as T & RankerScoredFields,
      index,
      id: resultId(result, index),
      finalScore,
    };
  });

  scored.sort((left, right) => {
    const diff = right.finalScore - left.finalScore;
    if (Math.abs(diff) > 1e-12) return diff;
    if (left.index !== right.index) return left.index - right.index;
    return left.id.localeCompare(right.id);
  });

  return {
    results: scored.map((entry) => entry.result),
    model_id: model.model_id,
  };
}

export function logisticScoreForRow(
  model: SearchRankerModel,
  row: Record<string, unknown>,
  query: string
): number {
  const questionType = classifyQuestionType(query);
  const features = serializeFeatures(extractFeatures(row, query, { question_type: questionType }));
  const coefficients = model.question_type_weights[questionType] ?? model.coefficients;
  let score = model.intercept;
  for (let index = 0; index < Math.min(coefficients.length, features.length); index += 1) {
    score += coefficients[index] * features[index];
  }
  if (score >= 35) return 1;
  if (score <= -35) return 0;
  return 1 / (1 + Math.exp(-score));
}
