
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';
function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(case_truth)').all() as Array<{ name: string }>)
    .map((col) => col.name)
    .sort();
}

function seedCase(db: Database.Database, caseId = 'case-phase-3-columns'): void {
  db.prepare(
    `
      INSERT INTO case_truth (case_id, title, created_at, updated_at)
      VALUES (?, 'Phase 3 columns', '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z')
    `
  ).run(caseId);
}

describe('case-first substrate — case_truth Phase 3 promotion and freshness columns', () => {
  it('adds promotion columns', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const names = columnNames(db);
    for (const column of [
      'canonical_decision_id',
      'canonical_event_id',
      'promoted_at',
      'promoted_by',
      'promotion_reason',
    ]) {
      expect(names).toContain(column);
    }

    db.close();
  });

  it('adds freshness columns', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const names = columnNames(db);
    for (const column of [
      'freshness_score',
      'freshness_state',
      'freshness_score_is_drifted',
      'freshness_drift_threshold',
      'freshness_checked_at',
      'freshness_reason_json',
    ]) {
      expect(names).toContain(column);
    }

    db.close();
  });

  it('rejects invalid freshness scores and thresholds', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db);

    expect(() =>
      db
        .prepare('UPDATE case_truth SET freshness_score = ? WHERE case_id = ?')
        .run(1.01, 'case-phase-3-columns')
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      db
        .prepare('UPDATE case_truth SET freshness_drift_threshold = ? WHERE case_id = ?')
        .run(-0.01, 'case-phase-3-columns')
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

  it('rejects invalid drift flags', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db);

    expect(() =>
      db
        .prepare('UPDATE case_truth SET freshness_score_is_drifted = ? WHERE case_id = ?')
        .run(2, 'case-phase-3-columns')
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

  it('rejects invalid freshness states', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db);

    expect(() =>
      db
        .prepare('UPDATE case_truth SET freshness_state = ? WHERE case_id = ?')
        .run('expired', 'case-phase-3-columns')
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

  it('defaults freshness_score_is_drifted to 0', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db);

    const row = db
      .prepare('SELECT freshness_score_is_drifted FROM case_truth WHERE case_id = ?')
      .get('case-phase-3-columns') as { freshness_score_is_drifted: number };

    expect(row.freshness_score_is_drifted).toBe(0);

    db.close();
  });

});
