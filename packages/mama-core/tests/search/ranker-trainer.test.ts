
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordSearchFeedback,
  type FeedbackStoreAdapter,
} from '../../src/search/feedback-store.js';
import {
  activateRankerModel,
  evaluateAgainstBaselines,
  insertRankerModelVersion,
  SEARCH_RANKER_FEATURE_SET_VERSION,
  trainOfflineRanker,
  type RankerTrainerAdapter,
} from '../../src/search/ranker-trainer.js';

import { applyMigrationsThrough } from '../../src/test-utils.js';
function setRetention(db: Database.Database, days: number): void {
  db.prepare(
    `
      UPDATE search_ranker_settings
      SET value_json = ?
      WHERE key = 'search_feedback_retention_days'
    `
  ).run(JSON.stringify(days));
}

function insertFeedback(
  adapter: FeedbackStoreAdapter,
  query: string,
  resultId: string,
  kind: 'shown' | 'accept' | 'reject' | 'hide' | 'click',
  createdAt = '2026-04-18T00:00:00.000Z'
): void {
  recordSearchFeedback(adapter, {
    result_id: `${kind}-${query}-${resultId}`,
    session_id: `session-${query}`,
    query,
    result_source_type: 'case',
    result_source_id: resultId,
    feedback_kind: kind,
    question_type: 'status',
    shown_index: Number(resultId.replace(/\D/g, '')) || 0,
    created_at: createdAt,
  });
}

describe('Phase 3 Task 11: offline ranker trainer', () => {
  let db: Database.Database;
  let adapter: FeedbackStoreAdapter & RankerTrainerAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    adapter = db as unknown as FeedbackStoreAdapter & RankerTrainerAdapter;
  });

  afterEach(() => {
    db.close();
  });

  it('returns insufficient_data when feedback is empty', async () => {
    const result = await trainOfflineRanker({ adapter });

    expect(result.status).toBe('insufficient_data');
    expect(result.counts).toEqual({ feedbackRows: 0, distinctQueries: 0 });
  });

  it('requires 1000 rows and 10 distinct queries by default', async () => {
    for (let index = 0; index < 20; index += 1) {
      insertFeedback(adapter, `query-${index % 10}`, `case-${index}`, 'accept');
    }

    const result = await trainOfflineRanker({ adapter });

    expect(result.status).toBe('insufficient_data');
    expect(result.counts.distinctQueries).toBe(10);
    expect(result.counts.feedbackRows).toBe(20);
  });

  it('allows seeded tests to lower training thresholds', async () => {
    insertFeedback(adapter, 'query-a', 'case-1', 'accept');
    insertFeedback(adapter, 'query-a', 'case-2', 'reject');
    insertFeedback(adapter, 'query-b', 'case-3', 'accept');
    insertFeedback(adapter, 'query-b', 'case-4', 'reject');

    const result = await trainOfflineRanker({
      adapter,
      minFeedbackRows: 4,
      minDistinctQueries: 2,
    });

    expect(result.status).toBe('trained');
    expect(result.model?.feature_set_version).toBe(SEARCH_RANKER_FEATURE_SET_VERSION);
  });

  it('caps neutral shown rows to 3x explicit labels per query', async () => {
    for (let index = 0; index < 100; index += 1) {
      insertFeedback(adapter, 'query-neutral', `shown-${index}`, 'shown');
    }
    insertFeedback(adapter, 'query-neutral', 'positive-1', 'accept');
    insertFeedback(adapter, 'query-neutral', 'positive-2', 'click');
    insertFeedback(adapter, 'query-neutral', 'negative-1', 'reject');

    const result = await trainOfflineRanker({
      adapter,
      minFeedbackRows: 1,
      minDistinctQueries: 1,
    });

    expect(result.status).toBe('trained');
    expect(result.model?.training_rows_count).toBe(12);
    expect(result.counts.feedbackRows).toBe(12);
  });

  it('uses retention as the default training window', async () => {
    setRetention(db, 1);
    insertFeedback(adapter, 'query-retention', 'case-old', 'accept', '2026-04-16T00:00:00.000Z');
    insertFeedback(adapter, 'query-retention', 'case-new', 'reject', '2026-04-18T00:00:00.000Z');

    const result = await trainOfflineRanker({
      adapter,
      minFeedbackRows: 1,
      minDistinctQueries: 1,
      now: new Date('2026-04-18T12:00:00.000Z'),
    });

    expect(result.counts.feedbackRows).toBe(1);
    expect(result.effectiveWindow.since).toBe('2026-04-17T12:00:00.000Z');
  });

  it('warns and persists a retention flag when explicit since exceeds retention', async () => {
    setRetention(db, 1);
    insertFeedback(adapter, 'query-warning', 'case-1', 'accept', '2026-04-16T00:00:00.000Z');
    insertFeedback(adapter, 'query-warning', 'case-2', 'reject', '2026-04-18T00:00:00.000Z');

    const result = await trainOfflineRanker({
      adapter,
      since: '2026-04-16T00:00:00.000Z',
      until: '2026-04-18T12:00:00.000Z',
      minFeedbackRows: 2,
      minDistinctQueries: 1,
      now: new Date('2026-04-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('trained');
    expect(result.effectiveWindow.retention_warning).toBe(true);

    const evaluation = await evaluateAgainstBaselines(
      { adapter, minFeedbackRows: 1, minDistinctQueries: 1 },
      result.model!
    );
    await insertRankerModelVersion(adapter, result.model!, evaluation);

    const row = db
      .prepare('SELECT training_window_json FROM ranker_model_versions WHERE model_id = ?')
      .get(result.model!.model_id) as { training_window_json: string };

    expect(JSON.parse(row.training_window_json)).toMatchObject({
      retention_warning: true,
      retention_days_at_train_time: 1,
    });
  });

  it('rejects activation for mismatched feature sets', async () => {
    db.prepare(
      `
        INSERT INTO ranker_model_versions (
          model_id, model_version, feature_set_version, coefficients_json, metrics_json,
          training_window_json, baseline_metrics_json, quality_gate_status, trained_at,
          trained_by, active
        )
        VALUES (
          'bad-version', 'v1', 'bad-version', '{"coefficients":[],"intercept":0}',
          '{}', '{}', '{}', 'passed', '2026-04-18T00:00:00.000Z', 'test', 0
        )
      `
    ).run();

    await expect(activateRankerModel(adapter, 'bad-version')).resolves.toBe('feature_set_mismatch');
  });
});
