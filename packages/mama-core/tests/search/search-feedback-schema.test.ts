
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';
function insertFeedback(
  db: Database.Database,
  overrides: Partial<{
    feedback_id: string;
    query: string;
    query_hash: Buffer;
    question_type: string;
    result_source_type: string;
    result_source_id: string;
    feedback_kind: string;
    rank_position: number;
    session_id: string | null;
  }> = {}
): void {
  const id = overrides.feedback_id ?? `fb-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `
      INSERT INTO search_feedback (
        feedback_id, query, query_hash, question_type, result_source_type, result_source_id,
        case_id, feedback_kind, rank_position, score_before, score_after, session_id,
        actor, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0.5, 0.7, ?, 'actor:test', '{}',
              '2026-04-18T00:00:00.000Z', NULL)
    `
  ).run(
    id,
    overrides.query ?? 'what is blocked',
    overrides.query_hash ?? Buffer.alloc(32, 2),
    overrides.question_type ?? 'status',
    overrides.result_source_type ?? 'case',
    overrides.result_source_id ?? `case-${id}`,
    overrides.feedback_kind ?? 'shown',
    overrides.rank_position ?? 0,
    overrides.session_id ?? 'session-1'
  );
}

function insertRankerModel(
  db: Database.Database,
  overrides: Partial<{
    model_id: string;
    quality_gate_status: string;
    active: number;
  }> = {}
): void {
  const id = overrides.model_id ?? `ranker-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `
      INSERT INTO ranker_model_versions (
        model_id, model_version, feature_set_version, coefficients_json, metrics_json,
        training_window_json, baseline_metrics_json, quality_gate_status, trained_at,
        trained_by, active
      )
      VALUES (?, 'v1', 'features-v1', '{"bias":0}', '{"ndcg":0.42}',
              '{"from":"2026-01-01","to":"2026-04-18"}', '{"bm25":{"ndcg":0.40}}',
              ?, '2026-04-18T00:00:00.000Z', 'test', ?)
    `
  ).run(id, overrides.quality_gate_status ?? 'passed', overrides.active ?? 0);
}

describe('case-first substrate — search feedback and ranker schema', () => {
  it('accepts every valid feedback kind', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    for (const kind of ['shown', 'click', 'accept', 'reject', 'hide']) {
      expect(() =>
        insertFeedback(db, {
          feedback_id: `fb-${kind}`,
          feedback_kind: kind,
          result_source_id: `result-${kind}`,
        })
      ).not.toThrow();
    }

    db.close();
  });

  it('rejects invalid question_type and feedback_kind values', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-invalid-question',
        question_type: 'not-a-question-type',
      })
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-invalid-kind',
        feedback_kind: 'bookmark',
      })
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

  it('enforces 32-byte query_hash values', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-short-hash',
        query_hash: Buffer.from('short'),
      })
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-valid-hash',
        query_hash: Buffer.alloc(32, 3),
      })
    ).not.toThrow();

    db.close();
  });

  it('dedupes shown feedback per session, query hash, result type, and result id', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const queryHash = Buffer.alloc(32, 4);
    insertFeedback(db, {
      feedback_id: 'fb-shown-1',
      query_hash: queryHash,
      result_source_type: 'case',
      result_source_id: 'case-1',
      feedback_kind: 'shown',
      session_id: 'session-a',
    });

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-shown-2',
        query_hash: queryHash,
        result_source_type: 'case',
        result_source_id: 'case-1',
        feedback_kind: 'shown',
        session_id: 'session-a',
      })
    ).toThrow(/UNIQUE constraint/i);

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-shown-3',
        query_hash: queryHash,
        result_source_type: 'case',
        result_source_id: 'case-1',
        feedback_kind: 'shown',
        session_id: null,
      })
    ).not.toThrow();

    db.close();
  });

  it('allows explicit accept and reject rows to coexist with shown feedback', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const queryHash = Buffer.alloc(32, 5);
    insertFeedback(db, {
      feedback_id: 'fb-coexist-shown',
      query_hash: queryHash,
      result_source_id: 'case-coexist',
      feedback_kind: 'shown',
    });

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-coexist-accept',
        query_hash: queryHash,
        result_source_id: 'case-coexist',
        feedback_kind: 'accept',
      })
    ).not.toThrow();

    expect(() =>
      insertFeedback(db, {
        feedback_id: 'fb-coexist-reject',
        query_hash: queryHash,
        result_source_id: 'case-coexist',
        feedback_kind: 'reject',
      })
    ).not.toThrow();

    const row = db.prepare('SELECT COUNT(*) AS count FROM search_feedback').get() as {
      count: number;
    };
    expect(row.count).toBe(3);

    db.close();
  });

  it('seeds search_feedback_retention_days as 180', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const row = db
      .prepare(
        "SELECT value_json FROM search_ranker_settings WHERE key = 'search_feedback_retention_days'"
      )
      .get() as { value_json: string } | undefined;

    expect(row?.value_json).toBe('180');

    db.close();
  });

  it('allows only one active ranker model', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    insertRankerModel(db, { model_id: 'ranker-active-1', active: 1 });
    expect(() => insertRankerModel(db, { model_id: 'ranker-active-2', active: 1 })).toThrow(
      /UNIQUE constraint/i
    );

    expect(() => insertRankerModel(db, { model_id: 'ranker-inactive', active: 0 })).not.toThrow();

    db.close();
  });

  it('stores baseline metrics and quality gate status', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    insertRankerModel(db, { model_id: 'ranker-metrics', quality_gate_status: 'not_run' });
    const row = db
      .prepare(
        `SELECT baseline_metrics_json, quality_gate_status
         FROM ranker_model_versions
         WHERE model_id = ?`
      )
      .get('ranker-metrics') as {
      baseline_metrics_json: string;
      quality_gate_status: string;
    };

    expect(JSON.parse(row.baseline_metrics_json)).toEqual({ bm25: { ndcg: 0.4 } });
    expect(row.quality_gate_status).toBe('not_run');

    expect(() =>
      insertRankerModel(db, {
        model_id: 'ranker-invalid-gate',
        quality_gate_status: 'unknown',
      })
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

});
