import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';

describe('case-first substrate — case_truth schema', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('case-truth-schema');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('creates the case_truth table', () => {
    const adapter = getAdapter();
    const row = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='case_truth'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('case_truth');
  });

  it('includes every §5.2 column', () => {
    const adapter = getAdapter();
    const cols = adapter.prepare('PRAGMA table_info(case_truth)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const names = new Set(cols.map((c) => c.name));
    const required = [
      'blockers',
      'canonical_case_id',
      'case_id',
      'compiled_at',
      'confidence',
      'created_at',
      'current_wiki_path',
      'last_activity_at',
      'primary_actors',
      'scope_refs',
      'split_from_case_id',
      'state_updated_at',
      'status',
      'status_reason',
      'title',
      'updated_at',
      'wiki_path_history',
    ];
    for (const col of required) {
      expect(names.has(col)).toBe(true);
    }
    // Phase 3 migration 048 adds promotion + freshness columns on top of
    // this §5.2 baseline; those are verified by
    // tests/cases/case-truth-phase-3-columns-schema.test.ts.
  });

  it('marks case_id as primary key and title/created_at/updated_at NOT NULL', () => {
    const adapter = getAdapter();
    const cols = adapter.prepare('PRAGMA table_info(case_truth)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.case_id.pk).toBe(1);
    expect(byName.title.notnull).toBe(1);
    expect(byName.created_at.notnull).toBe(1);
    expect(byName.updated_at.notnull).toBe(1);
    // nullable columns per spec §5.2
    expect(byName.current_wiki_path.notnull).toBe(0);
    expect(byName.canonical_case_id.notnull).toBe(0);
    expect(byName.split_from_case_id.notnull).toBe(0);
  });

  it('status is NOT NULL and defaults to active', () => {
    const adapter = getAdapter();
    const cols = adapter.prepare('PRAGMA table_info(case_truth)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const status = cols.find((c) => c.name === 'status')!;
    expect(status.notnull).toBe(1);
    // SQLite stores the default as the SQL literal including quotes
    expect(status.dflt_value).toMatch(/^'active'$/);

    // Insert a row without status and verify it lands as 'active'
    const now = new Date().toISOString();
    adapter
      .prepare(
        `INSERT INTO case_truth (case_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run('00000000-0000-0000-0000-000000000001', 'Default status test', now, now);
    const row = adapter
      .prepare('SELECT status FROM case_truth WHERE case_id = ?')
      .get('00000000-0000-0000-0000-000000000001') as { status: string };
    expect(row.status).toBe('active');
  });

  it('status CHECK rejects an invalid value', () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_truth (case_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          '00000000-0000-0000-0000-000000000002',
          'Invalid status',
          'not_a_valid_status',
          now,
          now
        )
    ).toThrow(/CHECK constraint/i);
  });

  it('current_wiki_path unique index is case-insensitive (COLLATE NOCASE)', () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();

    // Insert first row with a mixed-case path
    adapter
      .prepare(
        `INSERT INTO case_truth (case_id, current_wiki_path, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('00000000-0000-0000-0000-000000000010', 'Cases/Foo.md', 'First', now, now);

    // Attempting to insert a row with the same path in a different case
    // must fail via the UNIQUE index that uses COLLATE NOCASE
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_truth (case_id, current_wiki_path, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('00000000-0000-0000-0000-000000000011', 'cases/foo.md', 'Second', now, now)
    ).toThrow(/UNIQUE constraint/i);

    // A NULL current_wiki_path is allowed (partial index)
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_truth (case_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run('00000000-0000-0000-0000-000000000012', 'No path', now, now)
    ).not.toThrow();

    // Two rows with NULL current_wiki_path are allowed (partial index
    // skips NULL rows)
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_truth (case_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run('00000000-0000-0000-0000-000000000013', 'Another no path', now, now)
    ).not.toThrow();
  });

  it('expected indexes exist', () => {
    const adapter = getAdapter();
    const rows = adapter
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='case_truth' AND name LIKE 'idx_case_truth_%'"
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'idx_case_truth_canonical',
        'idx_case_truth_current_path',
        'idx_case_truth_last_activity',
        'idx_case_truth_status',
      ].sort()
    );
  });
});
