import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJSON } from '../../src/canonicalize.js';
import { getAdapter, type DatabaseAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  applyCorrection,
  insertCaseCorrectionLock,
  revertCorrection,
} from '../../src/cases/corrections.js';
import {
  buildCaseFieldTargetRef,
  buildMembershipTargetRef,
  buildWikiSectionTargetRef,
  canonicalTargetRef,
} from '../../src/cases/target-ref.js';

function resetCaseTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM memory_events').run();
  adapter.prepare('DELETE FROM case_corrections').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_truth').run();
}

function insertCase(
  overrides: Partial<{
    case_id: string;
    status: string;
    title: string;
    status_reason: string | null;
    primary_actors: string | null;
    blockers: string | null;
    confidence: string | null;
  }>
): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, status_reason, primary_actors,
          blockers, confidence, created_at, updated_at
        )
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      overrides.title ?? overrides.case_id,
      overrides.status ?? 'active',
      overrides.status_reason ?? null,
      overrides.primary_actors ?? null,
      overrides.blockers ?? null,
      overrides.confidence ?? null,
      now,
      now
    );
}

function insertMembership(input: {
  case_id: string;
  source_type?: 'decision' | 'event' | 'observation' | 'artifact';
  source_id: string;
  status?: string;
  role?: string | null;
  confidence?: number | null;
  reason?: string | null;
  user_locked?: 0 | 1;
  added_by?: string;
}): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status,
          added_by, added_at, user_locked, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.case_id,
      input.source_type ?? 'decision',
      input.source_id,
      input.role ?? null,
      input.confidence ?? null,
      input.reason ?? null,
      input.status ?? 'active',
      input.added_by ?? 'wiki-compiler',
      now,
      input.user_locked ?? 0,
      now
    );
}

function countRows(table: 'case_corrections' | 'case_memberships' | 'memory_events'): number {
  const row = getAdapter().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function decodeToken(token: string): {
  kid: string;
  payload: Record<string, unknown>;
  signature_hex: string;
} {
  return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
    kid: string;
    payload: Record<string, unknown>;
    signature_hex: string;
  };
}

function applyStatusCorrection(input: {
  case_id: string;
  old_value_json?: string | null;
  reconfirm_token?: string | null;
  new_value_json?: string;
}) {
  return applyCorrection(getAdapter(), {
    case_id: input.case_id,
    target_kind: 'case_field',
    target_ref: buildCaseFieldTargetRef('status'),
    field_name: 'status',
    old_value_json: input.old_value_json,
    reconfirm_token: input.reconfirm_token,
    session_id: 'turn-1',
    new_value_json: input.new_value_json ?? canonicalizeJSON('blocked'),
    reason: 'status correction',
    confirmed: true,
    confirmed_by: 'user:test',
    confirmation_summary: 'user confirmed status correction',
    now: '2026-04-18T01:00:00.000Z',
  });
}

describe('Phase 2 case correction write flows', () => {
  let testDbPath = '';
  const previousSecret = process.env.MAMA_RECONFIRM_TOKEN_SECRET;

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    process.env.MAMA_RECONFIRM_TOKEN_SECRET = Buffer.alloc(32, 7).toString('hex');
    testDbPath = await initTestDB('case-corrections-write-flow');
  });

  beforeEach(() => {
    resetCaseTables();
  });

  afterAll(async () => {
    if (previousSecret === undefined) {
      delete process.env.MAMA_RECONFIRM_TOKEN_SECRET;
    } else {
      process.env.MAMA_RECONFIRM_TOKEN_SECRET = previousSecret;
    }
    await cleanupTestDB(testDbPath);
  });

  it('returns precompile_gap without inserting correction or audit rows', () => {
    const result = applyStatusCorrection({ case_id: 'case-missing' });

    expect(result).toEqual({
      kind: 'precompile_gap',
      code: 'case.precompile_gap',
      case_id: 'case-missing',
    });
    expect(countRows('case_corrections')).toBe(0);
    expect(countRows('memory_events')).toBe(0);
  });

  it('returns a bound reconfirm token on CAS mismatch without inserting a correction row', () => {
    insertCase({ case_id: 'case-cas', status: 'active' });
    const target = canonicalTargetRef(buildCaseFieldTargetRef('status'));

    const result = applyStatusCorrection({
      case_id: 'case-cas',
      old_value_json: canonicalizeJSON('stale'),
      new_value_json: canonicalizeJSON('blocked'),
    });

    expect(result.kind).toBe('requires_reconfirm');
    if (result.kind !== 'requires_reconfirm') {
      throw new Error('Expected reconfirm result');
    }
    expect(countRows('case_corrections')).toBe(0);

    const envelope = decodeToken(result.reconfirm_token);
    expect(envelope.payload).toMatchObject({
      v: 1,
      case_id: 'case-cas',
      target_kind: 'case_field',
      target_ref_hash_hex: target.hash.toString('hex'),
      current_value_hash_hex: expect.any(String),
      proposed_value_hash_hex: expect.any(String),
      confirmed_by: 'user:test',
      session_id: 'turn-1',
      expires_at: expect.any(String),
    });
    expect(typeof envelope.kid).toBe('string');
    expect(envelope.kid).toBe(envelope.payload.kid);
    expect(envelope.signature_hex).toMatch(/^[0-9a-f]+$/);
  });

  it('canonicalizes old_value_json before deciding requires_reconfirm for membership targets', () => {
    insertCase({ case_id: 'case-membership-cas', status: 'active' });
    insertMembership({
      case_id: 'case-membership-cas',
      source_type: 'decision',
      source_id: 'dec-membership-cas',
      status: 'active',
      role: 'owner',
      confidence: 0.6,
      reason: 'existing',
      user_locked: 0,
    });

    const result = applyCorrection(getAdapter(), {
      case_id: 'case-membership-cas',
      target_kind: 'membership',
      target_ref: buildMembershipTargetRef('decision', 'dec-membership-cas'),
      old_value_json:
        '{"user_locked":0,"reason":"existing","confidence":0.6,"role":"owner","status":"active"}',
      new_value_json: canonicalizeJSON({
        status: 'removed',
        role: 'owner',
        confidence: 0.6,
        reason: 'existing',
        user_locked: 0,
      }),
      reason: 'remove membership',
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'remove membership',
      now: '2026-04-18T01:00:00.000Z',
    });

    expect(result).toMatchObject({ kind: 'applied' });
  });

  it('applies after reconfirm, rejects replay before mutation, and reverts by restoring truth', () => {
    insertCase({ case_id: 'case-reconfirm', status: 'active' });

    const reconfirm = applyStatusCorrection({
      case_id: 'case-reconfirm',
      old_value_json: canonicalizeJSON('stale'),
      new_value_json: canonicalizeJSON('blocked'),
    });
    expect(reconfirm.kind).toBe('requires_reconfirm');
    if (reconfirm.kind !== 'requires_reconfirm') {
      throw new Error('Expected reconfirm result');
    }

    const applied = applyStatusCorrection({
      case_id: 'case-reconfirm',
      old_value_json: canonicalizeJSON('stale'),
      reconfirm_token: reconfirm.reconfirm_token,
      new_value_json: canonicalizeJSON('blocked'),
    });

    expect(applied.kind).toBe('applied');
    if (applied.kind !== 'applied') {
      throw new Error('Expected correction to apply');
    }

    const statusRow = getAdapter()
      .prepare('SELECT status FROM case_truth WHERE case_id = ?')
      .get('case-reconfirm') as { status: string };
    expect(statusRow.status).toBe('blocked');

    const correctionRow = getAdapter()
      .prepare(
        `
          SELECT correction_id, length(target_ref_hash) AS hash_length, is_lock_active
          FROM case_corrections
          WHERE correction_id = ?
        `
      )
      .get(applied.correction_id) as {
      correction_id: string;
      hash_length: number;
      is_lock_active: number;
    };
    expect(correctionRow).toMatchObject({
      correction_id: applied.correction_id,
      hash_length: 32,
      is_lock_active: 1,
    });

    const replay = applyStatusCorrection({
      case_id: 'case-reconfirm',
      old_value_json: canonicalizeJSON('stale'),
      reconfirm_token: reconfirm.reconfirm_token,
      new_value_json: canonicalizeJSON('blocked'),
    });
    expect(replay).toMatchObject({
      kind: 'rejected',
      code: 'case.reconfirm_token_replayed',
    });

    const reverted = revertCorrection(getAdapter(), {
      correction_id: applied.correction_id,
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'release lock',
      now: '2026-04-18T01:10:00.000Z',
    });
    expect(reverted).toEqual({
      kind: 'reverted',
      correction_id: applied.correction_id,
      case_id: 'case-reconfirm',
    });

    const afterRevert = getAdapter()
      .prepare('SELECT status FROM case_truth WHERE case_id = ?')
      .get('case-reconfirm') as { status: string };
    expect(afterRevert.status).toBe('active');

    const events = getAdapter()
      .prepare('SELECT event_type FROM memory_events ORDER BY created_at ASC')
      .all() as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toEqual([
      'case.correction_applied',
      'case.correction_reverted',
    ]);
  });

  it('returns active correction conflict for a second active lock on the same target', () => {
    insertCase({ case_id: 'case-conflict', status: 'active' });

    const first = applyStatusCorrection({
      case_id: 'case-conflict',
      old_value_json: canonicalizeJSON('active'),
      new_value_json: canonicalizeJSON('blocked'),
    });
    expect(first.kind).toBe('applied');

    const second = applyStatusCorrection({
      case_id: 'case-conflict',
      old_value_json: canonicalizeJSON('blocked'),
      new_value_json: canonicalizeJSON('resolved'),
    });
    expect(second).toMatchObject({
      kind: 'rejected',
      code: 'case.correction_active_conflict',
    });
  });

  it('rejects revert on merged cases with a terminal-status result instead of throwing', () => {
    insertCase({ case_id: 'case-revert-merged', status: 'active' });
    insertCase({ case_id: 'case-survivor', status: 'active' });

    const applied = applyStatusCorrection({
      case_id: 'case-revert-merged',
      old_value_json: canonicalizeJSON('active'),
      new_value_json: canonicalizeJSON('blocked'),
    });
    expect(applied.kind).toBe('applied');
    if (applied.kind !== 'applied') {
      throw new Error('Expected correction to apply');
    }

    getAdapter()
      .prepare(`UPDATE case_truth SET status = 'merged', canonical_case_id = ? WHERE case_id = ?`)
      .run('case-survivor', 'case-revert-merged');

    const reverted = revertCorrection(getAdapter(), {
      correction_id: applied.correction_id,
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'attempt revert on merged case',
      now: '2026-04-18T01:10:00.000Z',
    });

    expect(reverted).toMatchObject({
      kind: 'rejected',
      code: 'case.terminal_status',
      case_id: 'case-revert-merged',
    });
  });

  it('accepts numeric confidence case-field corrections', () => {
    insertCase({
      case_id: 'case-confidence',
      status: 'active',
      confidence: '0.4',
    });

    const applied = applyCorrection(getAdapter(), {
      case_id: 'case-confidence',
      target_kind: 'case_field',
      field_name: 'confidence',
      target_ref: { kind: 'case_field', field: 'confidence' },
      old_value_json: canonicalizeJSON(0.4),
      new_value_json: canonicalizeJSON(0.8),
      reason: 'raise confidence',
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'raise confidence to numeric value',
      now: '2026-04-18T01:20:00.000Z',
    });

    expect(applied).toMatchObject({ kind: 'applied' });

    const row = getAdapter()
      .prepare('SELECT confidence FROM case_truth WHERE case_id = ?')
      .get('case-confidence') as { confidence: string | null };
    expect(row.confidence).toBe('0.8');
  });

  it('rejects active corrections against archived and merged cases', () => {
    for (const status of ['archived', 'merged'] as const) {
      resetCaseTables();
      insertCase({ case_id: `case-${status}`, status });

      const result = applyStatusCorrection({
        case_id: `case-${status}`,
        old_value_json: canonicalizeJSON(status),
        new_value_json: canonicalizeJSON('active'),
      });

      expect(result).toMatchObject({
        kind: 'rejected',
        code: 'case.terminal_status',
        case_id: `case-${status}`,
      });
      expect(countRows('case_corrections')).toBe(0);
    }
  });

  it('prepares the migration 041 correction INSERT shape without created_at or created_by', () => {
    const preparedSql: string[] = [];
    const fakeAdapter = {
      prepare(sql: string) {
        preparedSql.push(sql.replace(/\s+/g, ' ').trim());
        return {
          run: (..._args: unknown[]) => ({ changes: 1, lastInsertRowid: 0 }),
          get: (..._args: unknown[]) => undefined,
          all: (..._args: unknown[]) => [],
        };
      },
      transaction<T>(fn: () => T): T {
        return fn();
      },
    } as unknown as DatabaseAdapter;

    insertCaseCorrectionLock(fakeAdapter, {
      correction_id: 'corr-sql-shape',
      case_id: 'case-sql-shape',
      target_kind: 'case_field',
      target_ref: buildCaseFieldTargetRef('status'),
      field_name: 'status',
      old_value_json: canonicalizeJSON('active'),
      new_value_json: canonicalizeJSON('blocked'),
      reason: 'shape',
      applied_by: 'user:test',
      applied_at: '2026-04-18T00:00:00.000Z',
    });

    expect(preparedSql[0]).toBe(
      'INSERT INTO case_corrections ( correction_id, case_id, target_kind, target_ref_json, target_ref_hash, field_name, old_value_json, new_value_json, reason, applied_by, applied_at, is_lock_active, reverted_at, superseded_by ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?);'
    );
    expect(preparedSql[0]).not.toContain('created_at');
    expect(preparedSql[0]).not.toContain('created_by');
  });

  it('rolls back correction row, target mutation, and audit row when verification path fails', () => {
    insertCase({ case_id: 'case-rollback', status: 'active' });

    expect(() =>
      applyStatusCorrection({
        case_id: 'case-rollback',
        old_value_json: canonicalizeJSON('active'),
        new_value_json: canonicalizeJSON('not-a-status'),
      })
    ).toThrow(/constraint|CHECK/i);

    const row = getAdapter()
      .prepare('SELECT status FROM case_truth WHERE case_id = ?')
      .get('case-rollback') as { status: string };
    expect(row.status).toBe('active');
    expect(countRows('case_corrections')).toBe(0);
    expect(countRows('memory_events')).toBe(0);
  });

  it('remove active membership flips it to removed and user_locked=1', () => {
    insertCase({ case_id: 'case-remove-member' });
    insertMembership({ case_id: 'case-remove-member', source_id: 'dec-remove' });

    const result = applyCorrection(getAdapter(), {
      case_id: 'case-remove-member',
      target_kind: 'membership',
      target_ref: buildMembershipTargetRef('decision', 'dec-remove'),
      new_value_json: canonicalizeJSON({ status: 'removed' }),
      reason: 'does not belong',
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'remove source',
      now: '2026-04-18T02:00:00.000Z',
    });

    expect(result.kind).toBe('applied');
    const row = getAdapter()
      .prepare(
        `
          SELECT status, user_locked, added_by
          FROM case_memberships
          WHERE case_id = ? AND source_type = 'decision' AND source_id = ?
        `
      )
      .get('case-remove-member', 'dec-remove') as {
      status: string;
      user_locked: number;
      added_by: string;
    };
    expect(row).toEqual({ status: 'removed', user_locked: 1, added_by: 'user-correction' });
  });

  it('exclude source inserts or updates a non-active source to excluded and user_locked=1', () => {
    insertCase({ case_id: 'case-exclude-member' });

    const result = applyCorrection(getAdapter(), {
      case_id: 'case-exclude-member',
      target_kind: 'membership',
      target_ref: buildMembershipTargetRef('decision', 'dec-exclude'),
      new_value_json: canonicalizeJSON({
        status: 'excluded',
        confidence: 0.4,
        reason: 'explicitly out of scope',
      }),
      reason: 'exclude source',
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'exclude source',
      now: '2026-04-18T02:10:00.000Z',
    });

    expect(result.kind).toBe('applied');
    const row = getAdapter()
      .prepare(
        `
          SELECT status, role, confidence, reason, user_locked, added_by
          FROM case_memberships
          WHERE case_id = ? AND source_type = 'decision' AND source_id = ?
        `
      )
      .get('case-exclude-member', 'dec-exclude') as {
      status: string;
      role: string | null;
      confidence: number;
      reason: string;
      user_locked: number;
      added_by: string;
    };
    expect(row).toEqual({
      status: 'excluded',
      role: null,
      confidence: 0.4,
      reason: 'explicitly out of scope',
      user_locked: 1,
      added_by: 'user-correction',
    });
  });

  it("should belong inserts active membership with added_by='user-correction'", () => {
    insertCase({ case_id: 'case-should-belong' });

    const result = applyCorrection(getAdapter(), {
      case_id: 'case-should-belong',
      target_kind: 'membership',
      target_ref: buildMembershipTargetRef('decision', 'dec-add'),
      new_value_json: canonicalizeJSON({
        status: 'active',
        role: 'primary',
        confidence: 0.91,
        reason: 'user said this is the key source',
      }),
      reason: 'add source',
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'add source',
      now: '2026-04-18T02:20:00.000Z',
    });

    expect(result.kind).toBe('applied');
    const row = getAdapter()
      .prepare(
        `
          SELECT status, role, confidence, reason, user_locked, added_by
          FROM case_memberships
          WHERE case_id = ? AND source_type = 'decision' AND source_id = ?
        `
      )
      .get('case-should-belong', 'dec-add') as {
      status: string;
      role: string;
      confidence: number;
      reason: string;
      user_locked: number;
      added_by: string;
    };
    expect(row).toEqual({
      status: 'active',
      role: 'primary',
      confidence: 0.91,
      reason: 'user said this is the key source',
      user_locked: 1,
      added_by: 'user-correction',
    });
  });

  it('wiki_section correction inserts a canonical lock row without mutating case_truth fields', () => {
    insertCase({ case_id: 'case-wiki-section', status_reason: 'before' });
    const target = canonicalTargetRef(buildWikiSectionTargetRef('## Status'));

    const result = applyCorrection(getAdapter(), {
      case_id: 'case-wiki-section',
      target_kind: 'wiki_section',
      target_ref: buildWikiSectionTargetRef('## Status'),
      new_value_json: canonicalizeJSON({ markdown: '## Status\n\nHuman correction.' }),
      reason: 'wrong narrative section',
      confirmed: true,
      confirmed_by: 'user:test',
      confirmation_summary: 'correct wiki section',
      now: '2026-04-18T02:30:00.000Z',
    });

    expect(result.kind).toBe('applied');
    const correction = getAdapter()
      .prepare(
        `
          SELECT target_ref_json, length(target_ref_hash) AS hash_length
          FROM case_corrections
          WHERE case_id = ?
        `
      )
      .get('case-wiki-section') as { target_ref_json: string; hash_length: number };
    expect(correction).toEqual({ target_ref_json: target.json, hash_length: 32 });

    const truth = getAdapter()
      .prepare('SELECT status_reason FROM case_truth WHERE case_id = ?')
      .get('case-wiki-section') as { status_reason: string };
    expect(truth.status_reason).toBe('before');
  });

  // BLOCKER(P1-2) resolved by spec amendment-8 (2026-04-18). supersedeCorrection
  // shipped as Phase 2b with its own dedicated test file
  // `case-correction-supersede.test.ts` covering chain integrity, live-state
  // mutation, and the CAS/reconfirm protocol.
});
