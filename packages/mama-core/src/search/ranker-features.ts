import { classifyQuestionType, QUESTION_TYPES, type QuestionType } from './question-type.js';

export const SEARCH_RANKER_FEATURE_SET_VERSION = 'v1.0.0';

export type RankerSourceType =
  | 'decision'
  | 'event'
  | 'observation'
  | 'artifact'
  | 'connector_event';

export const RANKER_SOURCE_TYPES: readonly RankerSourceType[] = [
  'decision',
  'event',
  'observation',
  'artifact',
  'connector_event',
];

export interface RankerFeatureVector {
  bm25_score: number;
  vector_score: number;
  case_rollup_score: number;
  recency_score: number;
  same_case_boost: number;
  source_type_onehot: Record<RankerSourceType, number>;
  question_type_onehot: Record<QuestionType, number>;
}

export interface RankerQueryMeta {
  question_type?: QuestionType;
  case_id?: string | null;
}

type FeatureRow = Record<string, unknown>;

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function sourceTypeKey(row: FeatureRow): RankerSourceType | null {
  const sourceType = stringValue(
    row.source_type ?? row.result_source_type ?? row.kind ?? row.page_type
  );

  switch (sourceType) {
    case 'decision':
      return 'decision';
    case 'event':
    case 'checkpoint':
      return 'event';
    case 'observation':
    case 'case':
      return 'observation';
    case 'artifact':
    case 'wiki_page':
      return 'artifact';
    case 'connector_event':
    case 'standalone_connector_hit':
      return 'connector_event';
    default:
      return null;
  }
}

function zeroSourceOnehot(): Record<RankerSourceType, number> {
  return {
    decision: 0,
    event: 0,
    observation: 0,
    artifact: 0,
    connector_event: 0,
  };
}

function zeroQuestionOnehot(): Record<QuestionType, number> {
  return {
    correction: 0,
    artifact: 0,
    timeline: 0,
    status: 0,
    decision_reason: 0,
    how_to: 0,
    unknown: 0,
  };
}

export function extractFeatures(
  row: FeatureRow,
  query: string,
  queryMeta: RankerQueryMeta = {}
): RankerFeatureVector {
  const sourceOnehot = zeroSourceOnehot();
  const sourceType = sourceTypeKey(row);
  if (sourceType) {
    sourceOnehot[sourceType] = 1;
  }

  const questionType = queryMeta.question_type ?? classifyQuestionType(query);
  const questionOnehot = zeroQuestionOnehot();
  questionOnehot[questionType] = 1;

  const rowCaseId = stringValue(row.case_id ?? row.result_case_id);
  const queryCaseId = queryMeta.case_id ?? null;

  return {
    bm25_score: numberValue(row.bm25_score ?? row.bm25 ?? row.fts_score),
    vector_score: numberValue(row.vector_score ?? row.similarity),
    case_rollup_score: numberValue(
      row.case_rollup_score ?? row.retrieval_score ?? row.final_score ?? row.score
    ),
    recency_score: numberValue(row.recency_score),
    same_case_boost: queryCaseId && rowCaseId && queryCaseId === rowCaseId ? 1 : 0,
    source_type_onehot: sourceOnehot,
    question_type_onehot: questionOnehot,
  };
}

export function serializeFeatures(vec: RankerFeatureVector): number[] {
  return [
    vec.bm25_score,
    vec.vector_score,
    vec.case_rollup_score,
    vec.recency_score,
    vec.same_case_boost,
    ...RANKER_SOURCE_TYPES.map((sourceType) => vec.source_type_onehot[sourceType]),
    ...QUESTION_TYPES.map((questionType) => vec.question_type_onehot[questionType]),
  ];
}

export function featureSetVersion(): string {
  return SEARCH_RANKER_FEATURE_SET_VERSION;
}
