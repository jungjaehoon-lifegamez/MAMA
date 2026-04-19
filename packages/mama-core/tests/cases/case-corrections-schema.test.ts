import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';

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

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function insertCorrection(
  overrides: Partial<{
    correction_id: string;
    case_id: string;
    target_kind: string;
    target_ref_json: string;
    target_ref_hash: Buffer;
    field_name: string | null;
    old_value_json: string | null;
    new_value_json: string;
    reason: string;
    is_lock_active: number;
    reverted_at: string | null;
    applied_by: string;
  }> = {}
): void {
  const adapter = getAdapter();
  const now = new Date().toISOString();
  const target_ref_json = overrides.target_ref_json ?? '{"field":"status"}';
  const params = {
    correction_id: overrides.correction_id ?? `corr-${Math.random().toString(16).slice(2, 10)}`,
    case_id: overrides.case_id ?? '00000000-0000-0000-0000-0000000000C0',
    target_kind: overrides.target_kind ?? 'case_field',
    target_ref_json,
    target_ref_hash: overrides.target_ref_hash ?? sha256(target_ref_json),
    field_name: overrides.field_name ?? 'status',
    old_value_json: overrides.old_value_json ?? null,
    new_value_json: overrides.new_value_json ?? '"blocked"',
    reason: overrides.reason ?? 'user-intent',
    is_lock_active: overrides.is_lock_active ?? 1,
    reverted_at: overrides.reverted_at ?? null,
    applied_by: overrides.applied_by ?? 'user',
  };
  adapter
    .prepare(
      `INSERT INTO case_corrections
         (correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
          field_name, old_value_json, new_value_json, reason, is_lock_active,
          reverted_at, applied_by, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.correction_id,
      params.case_id,
      params.target_kind,
      params.target_ref_json,
      params.target_ref_hash,
      params.field_name,
      params.old_value_json,
      params.new_value_json,
      params.reason,
      params.is_lock_active,
      params.reverted_at,
      params.applied_by,
      now
    );
}

describe('case-first substrate — case_corrections schema', () => {
  let testDbPath = '';
  const caseA = '00000000-0000-0000-0000-0000000000C0';

  beforeAll(async () => {
    testDbPath = await initTestDB('case-corrections-schema');
    seedCase(caseA);
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('creates the case_corrections table', () => {
    const adapter = getAdapter();
    const row = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='case_corrections'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('case_corrections');
  });

  it('has target_ref_json and target_ref_hash columns', () => {
    const adapter = getAdapter();
    const cols = adapter.prepare('PRAGMA table_info(case_corrections)').all() as Array<{
      name: string;
      type: string;
    }>;
    const json = cols.find((c) => c.name === 'target_ref_json')!;
    const hash = cols.find((c) => c.name === 'target_ref_hash')!;
    expect(json.type).toBe('TEXT');
    expect(hash.type).toBe('BLOB');
  });

  it('rejects target_ref_hash that is not exactly 32 bytes', () => {
    expect(() => insertCorrection({ target_ref_hash: Buffer.from('short') })).toThrow(
      /CHECK constraint/i
    );
    expect(() => insertCorrection({ target_ref_hash: Buffer.alloc(64) })).toThrow(
      /CHECK constraint/i
    );
  });

  it('rejects NULL on target_kind', () => {
    const adapter = getAdapter();
    const target_ref_json = '{"field":"status"}';
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO case_corrections
             (correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
              new_value_json, reason, applied_by, applied_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'corr-null-kind',
          caseA,
          target_ref_json,
          sha256(target_ref_json),
          '"blocked"',
          'r',
          'user',
          new Date().toISOString()
        )
    ).toThrow(/NOT NULL constraint/i);
  });

  it('partial UNIQUE: active duplicate target_ref_hash for the same case is rejected', () => {
    const ref = '{"field":"status"}';
    const hash = sha256(ref);
    insertCorrection({
      correction_id: 'corr-active-1',
      target_ref_json: ref,
      target_ref_hash: hash,
      is_lock_active: 1,
    });
    expect(() =>
      insertCorrection({
        correction_id: 'corr-active-2',
        target_ref_json: ref,
        target_ref_hash: hash,
        is_lock_active: 1,
      })
    ).toThrow(/UNIQUE constraint/i);
  });

  it('partial UNIQUE: reverted or inactive duplicate target_ref_hash is ALLOWED', () => {
    const ref = '{"field":"last_activity_at"}';
    const hash = sha256(ref);
    insertCorrection({
      correction_id: 'corr-inactive-orig',
      target_ref_json: ref,
      target_ref_hash: hash,
      is_lock_active: 0,
    });
    // A second row with the same hash is allowed because neither is active
    expect(() =>
      insertCorrection({
        correction_id: 'corr-inactive-dup',
        target_ref_json: ref,
        target_ref_hash: hash,
        is_lock_active: 0,
      })
    ).not.toThrow();
    // A reverted row with the same hash is also allowed (active=1 but reverted_at set)
    expect(() =>
      insertCorrection({
        correction_id: 'corr-reverted',
        target_ref_json: ref,
        target_ref_hash: hash,
        is_lock_active: 1,
        reverted_at: new Date().toISOString(),
      })
    ).not.toThrow();
  });

});
