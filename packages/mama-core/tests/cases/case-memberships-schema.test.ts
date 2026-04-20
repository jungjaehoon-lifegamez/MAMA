import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';

/**
 * Helper: insert a case_truth row so memberships can reference it via FK.
 */
function seedCase(caseId: string, title = 'Seed case'): void {
  const adapter = getAdapter();
  const now = new Date().toISOString();
  adapter
    .prepare(
      `INSERT INTO case_truth (case_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(caseId, title, now, now);
}

describe('case-first substrate — case_memberships schema', () => {
  let testDbPath = '';
  const caseA = '00000000-0000-0000-0000-000000000A00';

  beforeAll(async () => {
    testDbPath = await initTestDB('case-memberships-schema');
    seedCase(caseA);
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('creates the case_memberships table', () => {
    const adapter = getAdapter();
    const row = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='case_memberships'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('case_memberships');
  });

  it('has primary key (case_id, source_type, source_id)', () => {
    const adapter = getAdapter();
    const cols = adapter.prepare('PRAGMA table_info(case_memberships)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(['case_id', 'source_type', 'source_id']);
  });

  it('user_locked defaults to 0 and is NOT NULL', () => {
    const adapter = getAdapter();
    const cols = adapter.prepare('PRAGMA table_info(case_memberships)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const ul = cols.find((c) => c.name === 'user_locked')!;
    expect(ul.notnull).toBe(1);
    expect(ul.dflt_value).toBe('0');

    const now = new Date().toISOString();
    adapter
      .prepare(
        `INSERT INTO case_memberships
           (case_id, source_type, source_id, status, added_by, added_at, updated_at)
         VALUES (?, 'decision', 'dec-default-lock', 'active', 'wiki-compiler', ?, ?)`
      )
      .run(caseA, now, now);
    const row = adapter
      .prepare(
        `SELECT user_locked FROM case_memberships
         WHERE case_id = ? AND source_type = 'decision' AND source_id = 'dec-default-lock'`
      )
      .get(caseA) as { user_locked: number };
    expect(row.user_locked).toBe(0);
  });

  it('rejects invalid source_type / status / added_by values', () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();

    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at)
           VALUES (?, 'not_a_type', 'src-1', 'active', 'wiki-compiler', ?, ?)`
        )
        .run(caseA, now, now)
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at)
           VALUES (?, 'decision', 'src-2', 'not_a_status', 'wiki-compiler', ?, ?)`
        )
        .run(caseA, now, now)
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at)
           VALUES (?, 'decision', 'src-3', 'active', 'not_an_added_by', ?, ?)`
        )
        .run(caseA, now, now)
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects NULL on source_type / status / added_by (NOT NULL enforcement)', () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();

    // NULL source_type
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at)
           VALUES (?, NULL, 'src-null-st', 'active', 'wiki-compiler', ?, ?)`
        )
        .run(caseA, now, now)
    ).toThrow(/NOT NULL constraint/i);

    // NULL status
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at)
           VALUES (?, 'decision', 'src-null-status', NULL, 'wiki-compiler', ?, ?)`
        )
        .run(caseA, now, now)
    ).toThrow(/NOT NULL constraint/i);

    // NULL added_by
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at)
           VALUES (?, 'decision', 'src-null-ab', 'active', NULL, ?, ?)`
        )
        .run(caseA, now, now)
    ).toThrow(/NOT NULL constraint/i);
  });

  it("accepts locked tombstone encoding (status='stale', user_locked=1)", () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at, user_locked)
           VALUES (?, 'decision', 'src-locked-tombstone', 'stale', 'user-correction', ?, ?, 1)`
        )
        .run(caseA, now, now)
    ).not.toThrow();

    const row = adapter
      .prepare(
        `SELECT status, user_locked FROM case_memberships
         WHERE case_id = ? AND source_type = 'decision' AND source_id = 'src-locked-tombstone'`
      )
      .get(caseA) as { status: string; user_locked: number };
    expect(row.status).toBe('stale');
    expect(row.user_locked).toBe(1);
  });

  it("rejects status='stale_locked' (Option B enum stays at 5 values)", () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_memberships
             (case_id, source_type, source_id, status, added_by, added_at, updated_at)
           VALUES (?, 'decision', 'src-stale-locked', 'stale_locked', 'user-correction', ?, ?)`
        )
        .run(caseA, now, now)
    ).toThrow(/CHECK constraint/i);
  });

  it('expected indexes exist', () => {
    const adapter = getAdapter();
    const rows = adapter
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='case_memberships' AND name LIKE 'idx_case_memberships_%'"
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      ['idx_case_memberships_case_status', 'idx_case_memberships_source'].sort()
    );
  });
});
