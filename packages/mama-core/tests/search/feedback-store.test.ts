import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getFeedbackRetentionDays,
  hashQuery,
  listSearchFeedback,
  recordSearchFeedback,
  type FeedbackStoreAdapter,
  type SearchFeedbackInput,
} from '../../src/search/feedback-store.js';

import { applyMigrationsThrough } from '../../src/test-utils.js';
function setRetention(db: Database.Database, days: number): void {
  db.prepare(
    `
      INSERT INTO search_ranker_settings (key, value_json, updated_at)
      VALUES ('search_feedback_retention_days', ?, '2026-04-18T00:00:00.000Z')
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `
  ).run(JSON.stringify(days));
}

function input(overrides: Partial<SearchFeedbackInput> = {}): SearchFeedbackInput {
  return {
    result_id: overrides.result_id ?? `feedback-${Math.random().toString(16).slice(2)}`,
    session_id: overrides.session_id ?? 'session-1',
    query: overrides.query ?? 'current status',
    result_source_type: overrides.result_source_type ?? 'case',
    result_source_id: overrides.result_source_id ?? 'case-1',
    feedback_kind: overrides.feedback_kind ?? 'shown',
    question_type: overrides.question_type ?? 'status',
    shown_index: overrides.shown_index ?? 0,
    result_case_id: overrides.result_case_id ?? null,
    clicked_result_rank: overrides.clicked_result_rank,
    created_at: overrides.created_at,
  };
}

describe('Phase 3 Task 10: search feedback store', () => {
  let db: Database.Database;
  let adapter: FeedbackStoreAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    adapter = db as unknown as FeedbackStoreAdapter;
  });

  afterEach(() => {
    db.close();
  });

  it('hashes normalized queries to 16 hex chars for external identity', () => {
    expect(hashQuery('  Current Status  ')).toBe(hashQuery('current status'));
    expect(hashQuery('current status')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('dedupes shown feedback with latest shown winning', () => {
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'shown-old',
        shown_index: 1,
        created_at: '2026-04-18T00:00:00.000Z',
      })
    );
    const result = recordSearchFeedback(
      adapter,
      input({
        result_id: 'shown-new',
        shown_index: 4,
        created_at: '2026-04-18T00:01:00.000Z',
      })
    );

    const rows = listSearchFeedback(adapter, {
      since: '2026-04-18T00:00:00.000Z',
      until: '2026-04-18T00:02:00.000Z',
    });

    expect(result.deduped).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rank_position: 4,
      session_id: 'session-1',
    });
    expect(rows[0]?.feedback_id).toBe(result.feedback_id);
  });

  it('compacts old shown rows but preserves explicit labels', () => {
    setRetention(db, 1);
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'old-shown',
        result_source_id: 'case-old-shown',
        created_at: '2026-01-01T00:00:00.000Z',
      })
    );
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'old-accept',
        result_source_id: 'case-old-accept',
        feedback_kind: 'accept',
        created_at: '2026-01-01T00:00:00.000Z',
      })
    );
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'new-shown',
        result_source_id: 'case-new-shown',
      })
    );

    const allRows = db
      .prepare('SELECT feedback_id, feedback_kind FROM search_feedback ORDER BY feedback_id')
      .all() as Array<{ feedback_id: string; feedback_kind: string }>;

    expect(allRows).toHaveLength(2);
    expect(allRows.map((row) => row.feedback_kind).sort()).toEqual(['accept', 'shown']);
  });

  it('allows multiple feedback events for the same result_id', () => {
    const shown = recordSearchFeedback(
      adapter,
      input({
        result_id: 'same-result-id',
        result_source_id: 'case-shared',
        feedback_kind: 'shown',
      })
    );
    const accepted = recordSearchFeedback(
      adapter,
      input({
        result_id: 'same-result-id',
        result_source_id: 'case-shared',
        feedback_kind: 'accept',
      })
    );

    const rows = db
      .prepare(
        `
          SELECT feedback_id, feedback_kind
          FROM search_feedback
          WHERE result_source_id = 'case-shared'
          ORDER BY created_at ASC, feedback_id ASC
        `
      )
      .all() as Array<{ feedback_id: string; feedback_kind: string }>;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.feedback_kind).sort()).toEqual(['accept', 'shown']);
    expect(shown.feedback_id).not.toBe(accepted.feedback_id);
  });

  it('uses the default retention window when listing feedback', () => {
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'recent',
        result_source_id: 'case-recent',
      })
    );
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'old',
        result_source_id: 'case-old',
        feedback_kind: 'accept',
        created_at: '2025-01-01T00:00:00.000Z',
      })
    );

    const rows = listSearchFeedback(adapter);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.feedback_kind).toBe('shown');
  });

  it('uses explicit since and until windows', () => {
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'inside',
        result_source_id: 'case-inside',
        created_at: '2026-04-18T00:30:00.000Z',
      })
    );
    recordSearchFeedback(
      adapter,
      input({
        result_id: 'outside',
        result_source_id: 'case-outside',
        created_at: '2026-04-18T02:30:00.000Z',
      })
    );

    const rows = listSearchFeedback(adapter, {
      since: '2026-04-18T00:00:00.000Z',
      until: '2026-04-18T01:00:00.000Z',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.feedback_kind).toBe('shown');
  });

  it('reads search_feedback_retention_days from settings', () => {
    setRetention(db, 14);

    expect(getFeedbackRetentionDays(adapter)).toBe(14);
  });
});
