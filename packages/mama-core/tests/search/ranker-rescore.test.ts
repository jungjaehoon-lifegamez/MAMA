
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SEARCH_RANKER_FEATURE_SET_VERSION } from '../../src/search/ranker-features.js';
import {
  rescoreSearchResults,
  type RankerRescoreAdapter,
} from '../../src/search/ranker-rescore.js';

import { applyMigrationsThrough } from '../../src/test-utils.js';
function insertModel(
  db: Database.Database,
  overrides: Partial<{
    feature_set_version: string;
    quality_gate_status: string;
    active: number;
  }> = {}
): void {
  const coefficients = {
    coefficients: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
    intercept: 0,
    question_type_weights: {
      correction: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
      artifact: [0, 0, 0, 0, 0, -4, -4, -4, 4, -4, 0, 0, 0, 0, 0, 0, 0],
      timeline: [0, 0, 0, 0, 0, -4, -4, -4, -4, 4, 0, 0, 0, 0, 0, 0, 0],
      status: [0, 0, 0, 0, 0, -4, -4, 4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
      decision_reason: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
      how_to: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
      unknown: [0, 0, 0, 0, 0, 4, -4, -4, -4, -4, 0, 0, 0, 0, 0, 0, 0],
    },
    training_rows_count: 10,
  };

  db.prepare(
    `
      INSERT INTO ranker_model_versions (
        model_id, model_version, feature_set_version, coefficients_json, metrics_json,
        training_window_json, baseline_metrics_json, quality_gate_status, trained_at,
        trained_by, active
      )
      VALUES (
        'ranker-active', 'v1', ?, ?, '{}', '{}', '{}', ?,
        '2026-04-18T00:00:00.000Z', 'test', ?
      )
    `
  ).run(
    overrides.feature_set_version ?? SEARCH_RANKER_FEATURE_SET_VERSION,
    JSON.stringify(coefficients),
    overrides.quality_gate_status ?? 'passed',
    overrides.active ?? 1
  );
}

describe('Phase 3 Task 12: ranker rescoring', () => {
  let db: Database.Database;
  let adapter: RankerRescoreAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    adapter = db as unknown as RankerRescoreAdapter;
  });

  afterEach(() => {
    db.close();
  });

  it('preserves order when no active model exists', () => {
    const result = rescoreSearchResults(adapter, {
      query: 'fix wrong decision',
      results: [
        { id: 'a', source_type: 'wiki_page', final_score: 0.9 },
        { id: 'b', source_type: 'decision', final_score: 0.1 },
      ],
    });

    expect(result.skipped_reason).toBe('no_active_model');
    expect(result.results.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('skips one-result inputs before model loading', () => {
    const result = rescoreSearchResults(adapter, {
      query: 'fix wrong decision',
      results: [{ id: 'a', source_type: 'decision', final_score: 0.9 }],
    });

    expect(result.skipped_reason).toBe('insufficient_result_count');
  });

  // Codex test bug: the 0.80*base + 0.20*ranker blend can't overcome a base
  // score delta of 0.6 (wiki=0.9 vs decision=0.3) since ranker_score is
  // Final score combines base and ranker as finalScore = 0.8 * base + 0.2 * ranker.
  // Any test that expects the ranker to flip order must start from base scores
  // within ~0.2 of each other, otherwise the 0.8 weight on the base dominates.
  it('reranks deterministically with an active model and preserves base score', () => {
    insertModel(db);

    const result = rescoreSearchResults(adapter, {
      query: 'fix wrong decision',
      results: [
        // Base scores intentionally tight; the ranker's source-type coefficients
        // (decision=+4, wiki_page=-4 for correction question type) are what
        // reorder them, not the base delta.
        { id: 'wiki', source_type: 'wiki_page', final_score: 0.55 },
        { id: 'decision', source_type: 'decision', final_score: 0.5 },
      ],
    });

    expect(result.model_id).toBe('ranker-active');
    expect(result.skipped_reason).toBeUndefined();
    // Decision wins despite starting below wiki, because its ranker_score
    // approaches 1 while wiki's approaches 0 for the correction question type.
    expect(result.results[0].id).toBe('decision');
    expect(result.results[0].ranker_score).toBeGreaterThan(0.9);
    expect(result.results[0].score_before_ranker).toBe(0.5);
    // wiki's ranker_score is strongly negative → close to 0 after logistic.
    expect(result.results[1].id).toBe('wiki');
    expect(result.results[1].ranker_score).toBeLessThan(0.1);
  });

  it('skips mismatched feature-set models', () => {
    insertModel(db, { feature_set_version: 'bad-version' });

    const result = rescoreSearchResults(adapter, {
      query: 'fix wrong decision',
      results: [
        { id: 'a', source_type: 'wiki_page', final_score: 0.9 },
        { id: 'b', source_type: 'decision', final_score: 0.1 },
      ],
    });

    expect(result.skipped_reason).toBe('feature_set_mismatch');
  });

  it('skips when legacy LLM reranking is requested', () => {
    insertModel(db);

    const result = rescoreSearchResults(adapter, {
      query: 'fix wrong decision',
      useReranking: true,
      results: [
        { id: 'a', source_type: 'decision', final_score: 0.9 },
        { id: 'b', source_type: 'wiki_page', final_score: 0.1 },
      ],
    });

    expect(result.skipped_reason).toBe('llm_reranking_requested');
  });

  it('preserves original order when final scores tie', () => {
    insertModel(db);

    const result = rescoreSearchResults(adapter, {
      query: 'fix wrong decision',
      results: [
        { id: 'first', source_type: 'decision', final_score: 0.5 },
        { id: 'second', source_type: 'decision', final_score: 0.5 },
      ],
    });

    expect(result.results.map((row) => row.id)).toEqual(['first', 'second']);
  });
});
