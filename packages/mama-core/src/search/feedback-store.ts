import { createHash, randomUUID } from 'node:crypto';

import type { RunResult } from '../db-adapter/statement.js';
import { classifyQuestionType, isQuestionType, type QuestionType } from './question-type.js';

export type SearchFeedbackKind = 'shown' | 'accept' | 'reject' | 'hide' | 'click';

export type SearchFeedbackSourceType =
  | 'decision'
  | 'checkpoint'
  | 'wiki_page'
  | 'case'
  | 'connector_event';

export interface SearchFeedbackInput {
  result_id: string;
  session_id?: string | null;
  query: string;
  result_source_type: SearchFeedbackSourceType;
  result_source_id: string;
  feedback_kind: SearchFeedbackKind;
  question_type?: QuestionType | null;
  shown_index: number;
  result_case_id?: string | null;
  clicked_result_rank?: number | null;
  created_at?: string;
}

export interface ListSearchFeedbackOptions {
  since?: string;
  until?: string;
  limit?: number;
}

export interface SearchFeedbackRow {
  feedback_id: string;
  query: string;
  query_hash_hex: string;
  question_type: QuestionType;
  result_source_type: SearchFeedbackSourceType;
  result_source_id: string;
  case_id: string | null;
  feedback_kind: SearchFeedbackKind;
  rank_position: number;
  score_before: number | null;
  score_after: number | null;
  session_id: string | null;
  actor: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface RecordSearchFeedbackResult {
  feedback_id: string;
  query_hash: string;
  deduped: boolean;
}

export interface FeedbackStoreAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction?<T>(fn: () => T): T | (() => T);
}

const DEFAULT_RETENTION_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizedQuery(query: string): string {
  return query.trim().toLowerCase();
}

function fullQueryHashHex(query: string): string {
  return createHash('sha256').update(normalizedQuery(query)).digest('hex');
}

function fullQueryHashBuffer(query: string): Buffer {
  return Buffer.from(fullQueryHashHex(query), 'hex');
}

export function hashQuery(query: string): string {
  return fullQueryHashHex(query).slice(0, 16);
}

function assertNonEmpty(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function assertRank(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function cutoffIso(retentionDays: number, now = new Date()): string {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY).toISOString();
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort((left, right) => left.localeCompare(right))) {
    const item = input[key];
    if (item !== undefined) {
      output[key] = stableObject(item);
    }
  }
  return output;
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(stableObject(value));
}

function runTransaction<T>(adapter: FeedbackStoreAdapter, fn: () => T): T {
  if (!adapter.transaction) {
    throw new Error('recordSearchFeedback requires adapter.transaction for atomic writes.');
  }

  const result = adapter.transaction(fn);
  if (typeof result === 'function') {
    return (result as () => T)();
  }
  return result;
}

function parseRetentionValue(value: string): number {
  const parsed = JSON.parse(value) as unknown;
  const numeric = typeof parsed === 'number' ? parsed : Number(parsed);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid search_feedback_retention_days value: ${value}`);
  }
  return Math.floor(numeric);
}

export function getFeedbackRetentionDays(adapter: FeedbackStoreAdapter): number {
  const row = adapter
    .prepare(
      `
        SELECT value_json
        FROM search_ranker_settings
        WHERE key = 'search_feedback_retention_days'
      `
    )
    .get() as { value_json?: string } | undefined;

  if (!row?.value_json) {
    return DEFAULT_RETENTION_DAYS;
  }

  return parseRetentionValue(row.value_json);
}

export function compactShownSearchFeedback(
  adapter: FeedbackStoreAdapter,
  retentionDays = getFeedbackRetentionDays(adapter)
): number {
  const result = adapter
    .prepare(
      `
        DELETE FROM search_feedback
        WHERE feedback_kind = 'shown'
          AND created_at < ?
      `
    )
    .run(cutoffIso(retentionDays));

  return result.changes;
}

function sessionForInput(input: SearchFeedbackInput, queryHash: string): string | null {
  if (input.session_id && input.session_id.trim().length > 0) {
    return input.session_id;
  }

  if (input.feedback_kind === 'shown') {
    return `anonymous:${queryHash}`;
  }

  return input.session_id ?? null;
}

function rankPositionForInput(input: SearchFeedbackInput): number {
  if (input.feedback_kind === 'click' && input.clicked_result_rank !== undefined) {
    const rank = input.clicked_result_rank ?? input.shown_index;
    assertRank(rank, 'clicked_result_rank');
    return rank;
  }

  assertRank(input.shown_index, 'shown_index');
  return input.shown_index;
}

function questionTypeForInput(input: SearchFeedbackInput): QuestionType {
  if (input.question_type && isQuestionType(input.question_type)) {
    return input.question_type;
  }

  return classifyQuestionType(input.query);
}

export function recordSearchFeedback(
  adapter: FeedbackStoreAdapter,
  input: SearchFeedbackInput
): RecordSearchFeedbackResult {
  assertNonEmpty(input.result_id, 'result_id');
  assertNonEmpty(input.query, 'query');
  assertNonEmpty(input.result_source_type, 'result_source_type');
  assertNonEmpty(input.result_source_id, 'result_source_id');

  const queryHashHex = fullQueryHashHex(input.query);
  const queryHash = fullQueryHashBuffer(input.query);
  const queryHashShort = queryHashHex.slice(0, 16);
  const sessionId = sessionForInput(input, queryHashShort);
  const questionType = questionTypeForInput(input);
  const rankPosition = rankPositionForInput(input);
  const createdAt = input.created_at ?? nowIso();
  const feedbackId = `search_feedback_${randomUUID()}`;
  const metadataJson = canonicalJson({
    clicked_result_rank: input.clicked_result_rank ?? null,
    input_result_id: input.result_id,
  });

  return runTransaction(adapter, () => {
    let deduped = false;

    if (input.feedback_kind === 'shown') {
      compactShownSearchFeedback(adapter);

      if (sessionId) {
        const deleted = adapter
          .prepare(
            `
              DELETE FROM search_feedback
              WHERE feedback_kind = 'shown'
                AND session_id = ?
                AND query_hash = ?
                AND result_source_type = ?
                AND result_source_id = ?
            `
          )
          .run(sessionId, queryHash, input.result_source_type, input.result_source_id);

        deduped = deleted.changes > 0;
      }
    }

    adapter
      .prepare(
        `
          INSERT INTO search_feedback (
            feedback_id, query, query_hash, question_type, result_source_type, result_source_id,
            case_id, feedback_kind, rank_position, score_before, score_after, session_id,
            actor, metadata_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'system:search-feedback', ?, ?, NULL)
        `
      )
      .run(
        feedbackId,
        input.query,
        queryHash,
        questionType,
        input.result_source_type,
        input.result_source_id,
        input.result_case_id ?? null,
        input.feedback_kind,
        rankPosition,
        sessionId,
        metadataJson,
        createdAt
      );

    return {
      feedback_id: feedbackId,
      query_hash: queryHashShort,
      deduped,
    };
  });
}

export function listSearchFeedback(
  adapter: FeedbackStoreAdapter,
  options: ListSearchFeedbackOptions = {}
): SearchFeedbackRow[] {
  const retentionDays = getFeedbackRetentionDays(adapter);
  const until = options.until ?? nowIso();
  const since = options.since ?? cutoffIso(retentionDays, new Date(until));
  const limit = options.limit ?? 10_000;

  assertRank(limit, 'limit');

  const rows = adapter
    .prepare(
      `
        SELECT
          feedback_id,
          query,
          lower(hex(query_hash)) AS query_hash_hex,
          question_type,
          result_source_type,
          result_source_id,
          case_id,
          feedback_kind,
          rank_position,
          score_before,
          score_after,
          session_id,
          actor,
          metadata_json,
          created_at,
          updated_at
        FROM search_feedback
        WHERE created_at >= ?
          AND created_at <= ?
        ORDER BY created_at ASC, feedback_id ASC
        LIMIT ?
      `
    )
    .all(since, until, limit) as SearchFeedbackRow[];

  return rows;
}
