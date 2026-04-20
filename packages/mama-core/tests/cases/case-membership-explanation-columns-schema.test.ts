
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';
function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(case_memberships)').all() as Array<{ name: string }>)
    .map((col) => col.name)
    .sort();
}

function seedCase(db: Database.Database, caseId = 'case-membership-explain'): void {
  db.prepare(
    `
      INSERT INTO case_truth (case_id, title, created_at, updated_at)
      VALUES (?, 'Membership explanation', '2026-04-18T00:00:00.000Z',
              '2026-04-18T00:00:00.000Z')
    `
  ).run(caseId);
}

describe('case-first substrate — case_memberships explanation columns', () => {
  it('adds nullable explanation columns', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const names = columnNames(db);
    expect(names).toContain('assignment_strategy');
    expect(names).toContain('score_breakdown_json');
    expect(names).toContain('source_locator');
    expect(names).toContain('explanation_updated_at');

    db.close();
  });

  it('preserves existing membership inserts that omit explanation fields', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db);

    expect(() =>
      db
        .prepare(
          `
            INSERT INTO case_memberships (
              case_id, source_type, source_id, status, added_by, added_at, updated_at
            )
            VALUES (?, 'decision', 'dec-legacy', 'active', 'wiki-compiler',
                    '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z')
          `
        )
        .run('case-membership-explain')
    ).not.toThrow();

    const row = db
      .prepare(
        `SELECT assignment_strategy, score_breakdown_json, source_locator, explanation_updated_at
         FROM case_memberships
         WHERE case_id = ? AND source_type = 'decision' AND source_id = 'dec-legacy'`
      )
      .get('case-membership-explain') as {
      assignment_strategy: string | null;
      score_breakdown_json: string | null;
      source_locator: string | null;
      explanation_updated_at: string | null;
    };

    expect(row).toEqual({
      assignment_strategy: null,
      score_breakdown_json: null,
      source_locator: null,
      explanation_updated_at: null,
    });

    db.close();
  });

  it('stores deterministic score breakdown JSON and source locator values', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db);

    const scoreBreakdown = {
      entity_overlap: 0.8,
      embedding_similarity: 0.7,
      temporal_proximity: 0.6,
      explicit_from_wiki: 1,
      total: 0.77,
    };

    db.prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, status, added_by, added_at, updated_at,
          assignment_strategy, score_breakdown_json, source_locator, explanation_updated_at
        )
        VALUES (?, 'decision', 'dec-explained', 'active', 'wiki-compiler',
                '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z',
                'wiki_explicit_source', ?, 'obsidian://Cases/Alpha.md#evidence',
                '2026-04-18T00:00:00.000Z')
      `
    ).run('case-membership-explain', JSON.stringify(scoreBreakdown));

    const row = db
      .prepare(
        `SELECT assignment_strategy, score_breakdown_json, source_locator, explanation_updated_at
         FROM case_memberships
         WHERE case_id = ? AND source_type = 'decision' AND source_id = 'dec-explained'`
      )
      .get('case-membership-explain') as {
      assignment_strategy: string;
      score_breakdown_json: string;
      source_locator: string;
      explanation_updated_at: string;
    };

    expect(row.assignment_strategy).toBe('wiki_explicit_source');
    expect(JSON.parse(row.score_breakdown_json)).toEqual(scoreBreakdown);
    expect(row.source_locator).toBe('obsidian://Cases/Alpha.md#evidence');
    expect(row.explanation_updated_at).toBe('2026-04-18T00:00:00.000Z');

    db.close();
  });

});
