import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { applyCorrection, supersedeCorrection } from '../../src/cases/corrections.js';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = 'entity_supersede';
const NOW = '2026-04-18T04:00:00.000Z';

function insertCase(status: string = 'active'): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, primary_actors,
          compiled_at, created_at, updated_at
        )
        VALUES (?, 'cases/s.md', 'Supersede Case', ?, ?, ?, ?, ?)
      `
    )
    .run(CASE_ID, status, JSON.stringify([{ entity_id: ENTITY_ID, role: 'owner' }]), NOW, NOW, NOW);
}

function resetTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM memory_events').run();
  adapter.prepare('DELETE FROM case_corrections').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_truth').run();
}

function applyInitialCorrection(): string {
  const result = applyCorrection(getAdapter(), {
    case_id: CASE_ID,
    target_kind: 'case_field',
    target_ref: { kind: 'case_field', field: 'status_reason' },
    field_name: 'status_reason',
    old_value_json: null,
    new_value_json: JSON.stringify('blocked on CI'),
    reason: 'Initial user correction',
    confirmed: true,
    confirmed_by: 'user-1',
    confirmation_summary: 'Confirmed status_reason correction',
    now: NOW,
  });
  if (result.kind !== 'applied') {
    throw new Error(`expected applied, got ${result.kind}`);
  }
  return result.correction_id;
}

const RECONFIRM_SECRET = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('Phase 2b Task — supersedeCorrection (spec amendment-8 unblocked)', () => {
  let testDbPath = '';
  const originalSecret = process.env.MAMA_RECONFIRM_TOKEN_SECRET;

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    process.env.MAMA_RECONFIRM_TOKEN_SECRET = RECONFIRM_SECRET;
    testDbPath = await initTestDB('case-correction-supersede');
  });

  beforeEach(() => {
    resetTables();
    insertCase();
  });

  afterAll(async () => {
    if (originalSecret === undefined) {
      delete process.env.MAMA_RECONFIRM_TOKEN_SECRET;
    } else {
      process.env.MAMA_RECONFIRM_TOKEN_SECRET = originalSecret;
    }
    await cleanupTestDB(testDbPath);
  });

  it('INSERTs new row, sets OLD.superseded_by + is_lock_active=0 atomically', () => {
    const oldId = applyInitialCorrection();

    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('still blocked on legal'),
      reason: 'User revised blocker',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'User changed their mind on blocker reason',
      now: NOW,
    });

    expect(result.kind).toBe('superseded');
    if (result.kind !== 'superseded') return;

    const rows = getAdapter()
      .prepare(
        'SELECT correction_id, is_lock_active, reverted_at, superseded_by FROM case_corrections ORDER BY applied_at'
      )
      .all() as Array<{
      correction_id: string;
      is_lock_active: number;
      reverted_at: string | null;
      superseded_by: string | null;
    }>;

    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.correction_id === oldId);
    const fresh = rows.find((r) => r.correction_id === result.new_correction_id);
    expect(old).toMatchObject({
      is_lock_active: 0,
      reverted_at: null,
      superseded_by: result.new_correction_id,
    });
    expect(fresh).toMatchObject({
      is_lock_active: 1,
      reverted_at: null,
      superseded_by: null,
    });
  });

  it('emits case.correction_superseded memory_event with predecessor linkage', () => {
    const oldId = applyInitialCorrection();
    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('now resolved'),
      reason: 'User resolved the blocker',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'Resolved',
      now: NOW,
    });

    if (result.kind !== 'superseded') throw new Error('expected superseded');

    const events = getAdapter()
      .prepare(
        "SELECT event_type, reason, evidence_refs FROM memory_events WHERE event_type = 'case.correction_superseded'"
      )
      .all() as Array<{ event_type: string; reason: string; evidence_refs: string }>;

    expect(events).toHaveLength(1);
    const refs = JSON.parse(events[0].evidence_refs);
    expect(refs).toContain(result.new_correction_id);
    expect(refs).toContain(oldId);
  });

  it('rejects supersede on already-superseded correction', () => {
    const oldId = applyInitialCorrection();
    supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision 1'),
      reason: 'first revision',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'rev1',
      now: NOW,
    });

    const second = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision 2'),
      reason: 'second revision',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'rev2',
      now: NOW,
    });

    expect(second).toMatchObject({
      kind: 'rejected',
      code: 'case.correction_already_superseded',
    });
  });

  it('rejects supersede on reverted correction', () => {
    const oldId = applyInitialCorrection();
    getAdapter()
      .prepare(
        'UPDATE case_corrections SET reverted_at = ?, is_lock_active = 0 WHERE correction_id = ?'
      )
      .run(NOW, oldId);

    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('too late'),
      reason: 'late attempt',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'late',
      now: NOW,
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.correction_reverted',
    });
  });

  it('rejects supersede on missing correction_id', () => {
    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: '00000000-0000-0000-0000-000000000000',
      new_value_json: JSON.stringify('x'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      now: NOW,
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.correction_not_found',
    });
  });

  it('mutates live case_truth.status_reason to the new value (P1-1 fix)', () => {
    const oldId = applyInitialCorrection();

    // Sanity: applyCorrection already wrote 'blocked on CI' to case_truth.status_reason
    const before = getAdapter()
      .prepare('SELECT status_reason FROM case_truth WHERE case_id = ?')
      .get(CASE_ID) as { status_reason: string | null };
    expect(before.status_reason).toBe('blocked on CI');

    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('still blocked on legal'),
      reason: 'User revised blocker',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'User changed their mind on blocker reason',
      now: NOW,
    });
    expect(result.kind).toBe('superseded');

    // After supersede, the live target must reflect the revised value.
    const after = getAdapter()
      .prepare('SELECT status_reason FROM case_truth WHERE case_id = ?')
      .get(CASE_ID) as { status_reason: string | null };
    expect(after.status_reason).toBe('still blocked on legal');
  });

  it('new superseded row preserves the pre-mutation current value as old_value_json (P1-1 fix)', () => {
    const oldId = applyInitialCorrection();
    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('replan'),
      reason: 'Revised',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'revised',
      now: NOW,
    });
    if (result.kind !== 'superseded') throw new Error('expected superseded');

    const newRow = getAdapter()
      .prepare(
        'SELECT old_value_json, new_value_json FROM case_corrections WHERE correction_id = ?'
      )
      .get(result.new_correction_id) as { old_value_json: string | null; new_value_json: string };

    // old_value_json must snapshot the value that was live BEFORE supersede
    // (i.e., what applyCorrection had written: 'blocked on CI'). NULL loses
    // the snapshot and breaks audit / rollback reasoning.
    expect(newRow.old_value_json).toBe(JSON.stringify('blocked on CI'));
    expect(newRow.new_value_json).toBe(JSON.stringify('replan'));
  });

  it('returns requires_reconfirm when expected_current_value_json disagrees with live value (P2-1 fix)', () => {
    const oldId = applyInitialCorrection();

    // Simulate drift: someone (e.g. another sub-agent) wrote the live
    // case_truth.status_reason after the user opened the drawer.
    getAdapter()
      .prepare('UPDATE case_truth SET status_reason = ? WHERE case_id = ?')
      .run('drifted by another writer', CASE_ID);

    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('user intended revision'),
      reason: 'User revised blocker',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'revised',
      expected_current_value_json: JSON.stringify('blocked on CI'),
      session_id: 'session-1',
      now: NOW,
    });

    expect(result.kind).toBe('requires_reconfirm');
    if (result.kind !== 'requires_reconfirm') return;
    expect(result.code).toBe('case.correction_requires_reconfirm');
    expect(result.current_value_json).toBe('"drifted by another writer"');
    expect(result.proposed_new_value_json).toBe('"user intended revision"');
    expect(typeof result.reconfirm_token).toBe('string');
  });

  it('applies supersede on retry with the exact reconfirm token (P2-1 fix)', () => {
    const oldId = applyInitialCorrection();
    // Live state is 'blocked on CI' (written by applyInitialCorrection). Drift
    // another writer's value so CAS is triggered by `expected != live`.
    getAdapter()
      .prepare('UPDATE case_truth SET status_reason = ? WHERE case_id = ?')
      .run('drifted', CASE_ID);

    const stale = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      expected_current_value_json: JSON.stringify('blocked on CI'),
      session_id: 'sess',
      now: NOW,
    });
    if (stale.kind !== 'requires_reconfirm') throw new Error('expected drift');

    // Retry with the same expected (still mismatches live 'drifted') and the
    // token — this keeps CAS triggered so the token path is exercised.
    const retry = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      expected_current_value_json: JSON.stringify('blocked on CI'),
      reconfirm_token: stale.reconfirm_token,
      session_id: 'sess',
      now: NOW,
    });

    expect(retry.kind).toBe('superseded');
    if (retry.kind !== 'superseded') return;

    const after = getAdapter()
      .prepare('SELECT status_reason FROM case_truth WHERE case_id = ?')
      .get(CASE_ID) as { status_reason: string };
    expect(after.status_reason).toBe('revision');
  });

  it('rejects replay of consumed reconfirm token on supersede (P2-1 fix)', () => {
    const oldId = applyInitialCorrection();
    getAdapter()
      .prepare('UPDATE case_truth SET status_reason = ? WHERE case_id = ?')
      .run('drifted', CASE_ID);

    const stale = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      expected_current_value_json: JSON.stringify('blocked on CI'),
      session_id: 'sess',
      now: NOW,
    });
    if (stale.kind !== 'requires_reconfirm') throw new Error('expected drift');

    const firstRetry = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      expected_current_value_json: JSON.stringify('blocked on CI'),
      reconfirm_token: stale.reconfirm_token,
      session_id: 'sess',
      now: NOW,
    });
    expect(firstRetry.kind).toBe('superseded');
    if (firstRetry.kind !== 'superseded') return;

    // Replay: token already burned by firstRetry. Passing it again with an
    // expected that still triggers CAS must reject BEFORE any row writes.
    const replay = supersedeCorrection(getAdapter(), {
      old_correction_id: firstRetry.new_correction_id,
      new_value_json: JSON.stringify('revision'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      expected_current_value_json: JSON.stringify('blocked on CI'),
      reconfirm_token: stale.reconfirm_token,
      session_id: 'sess',
      now: NOW,
    });

    expect(replay).toMatchObject({
      kind: 'rejected',
      code: 'case.reconfirm_token_replayed',
    });
  });

  it('supersede on membership target mutates case_memberships live state (review P3-5)', () => {
    const applyResult = applyCorrection(getAdapter(), {
      case_id: CASE_ID,
      target_kind: 'membership',
      target_ref: { kind: 'membership', source_type: 'decision', source_id: 'dec-mem-1' },
      old_value_json: null,
      new_value_json: JSON.stringify({
        status: 'active',
        role: 'supporting',
        confidence: 0.8,
        reason: 'user-included',
      }),
      reason: 'user-included',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'inc',
      now: NOW,
    });
    if (applyResult.kind !== 'applied') throw new Error('apply failed');

    // Supersede the membership correction: flip status to removed.
    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: applyResult.correction_id,
      new_value_json: JSON.stringify({ status: 'removed' }),
      reason: 'user-changed-mind',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'removed',
      now: NOW,
    });
    expect(result.kind).toBe('superseded');

    // Live case_memberships row must reflect the superseded value.
    const row = getAdapter()
      .prepare(
        `
          SELECT status, user_locked, added_by
          FROM case_memberships
          WHERE case_id = ? AND source_type = 'decision' AND source_id = 'dec-mem-1'
        `
      )
      .get(CASE_ID) as { status: string; user_locked: number; added_by: string };
    expect(row).toMatchObject({ status: 'removed', user_locked: 1, added_by: 'user-correction' });
  });

  it('supersede on wiki_section target is overlay-only (no DB mutation path) (review P3-5)', () => {
    const targetRefJson = JSON.stringify({ kind: 'wiki_section', section_heading: 'Blockers' });
    const correctionId = 'corr-wiki-1';
    // Seed a wiki_section correction directly.
    getAdapter()
      .prepare(
        `
          INSERT INTO case_corrections (
            correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
            field_name, old_value_json, new_value_json, reason, is_lock_active,
            superseded_by, reverted_at, applied_by, applied_at
          )
          VALUES (?, ?, 'wiki_section', ?, ?, NULL, ?, ?, 'seed', 1, NULL, NULL, 'user-1', ?)
        `
      )
      .run(
        correctionId,
        CASE_ID,
        targetRefJson,
        require('node:crypto').createHash('sha256').update(targetRefJson).digest(),
        JSON.stringify('old narrative'),
        JSON.stringify('new narrative'),
        NOW
      );

    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: correctionId,
      new_value_json: JSON.stringify('revised narrative'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      now: NOW,
    });
    expect(result.kind).toBe('superseded');

    // Overlay semantics: the NEW row carries the revised narrative but no
    // live case_truth mutation occurs (wiki sections aren't DB-backed here).
    const rows = getAdapter()
      .prepare(
        'SELECT correction_id, target_kind, is_lock_active, superseded_by FROM case_corrections ORDER BY applied_at'
      )
      .all() as Array<{
      correction_id: string;
      target_kind: string;
      is_lock_active: number;
      superseded_by: string | null;
    }>;
    expect(rows).toHaveLength(2);
    const newRow = rows.find((r) => r.correction_id !== correctionId);
    expect(newRow).toMatchObject({ target_kind: 'wiki_section', is_lock_active: 1 });
  });

  // Note: "case_truth deleted mid-flight" is prevented at the schema layer
  // by the FK on case_corrections.case_id → case_truth.case_id. The
  // precompile_gap branch in supersedeCorrection is defensive and
  // intentionally unreachable under normal FK enforcement.

  it('canonicalizes expected_current_value_json before CAS comparison (review P2-3)', () => {
    const oldId = applyInitialCorrection();
    // Live status_reason is "blocked on CI". Passing the same value with
    // extra whitespace must NOT trigger bogus CAS drift.
    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      expected_current_value_json: '  "blocked on CI"  ',
      session_id: 'sess',
      now: NOW,
    });
    expect(result.kind).toBe('superseded');
  });

  it('rejects supersede when case_truth is in terminal status (case_field target) (review P1-1)', () => {
    const oldId = applyInitialCorrection();
    // Mark the case as merged post-apply — simulates case merged into a
    // survivor AFTER the original correction landed.
    getAdapter().prepare("UPDATE case_truth SET status = 'merged' WHERE case_id = ?").run(CASE_ID);

    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: oldId,
      new_value_json: JSON.stringify('revision'),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      now: NOW,
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.terminal_status',
    });
    // No new row, no memory event, OLD row still locked.
    const rows = getAdapter()
      .prepare('SELECT correction_id, is_lock_active, superseded_by FROM case_corrections')
      .all() as Array<{
      correction_id: string;
      is_lock_active: number;
      superseded_by: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ is_lock_active: 1, superseded_by: null });
    const events = getAdapter()
      .prepare(
        "SELECT COUNT(*) AS c FROM memory_events WHERE event_type = 'case.correction_superseded'"
      )
      .get() as { c: number };
    expect(events.c).toBe(0);
  });

  it('rejects supersede when case_truth is terminal (membership target) (review P1-1)', () => {
    // Seed a membership correction.
    const applyResult = applyCorrection(getAdapter(), {
      case_id: CASE_ID,
      target_kind: 'membership',
      target_ref: { kind: 'membership', source_type: 'decision', source_id: 'dec-1' },
      old_value_json: null,
      new_value_json: JSON.stringify({
        status: 'active',
        role: 'supporting',
        confidence: 0.9,
        reason: 'included by user',
      }),
      reason: 'user-included',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'inc',
      now: NOW,
    });
    if (applyResult.kind !== 'applied') throw new Error('seed failed');

    getAdapter()
      .prepare("UPDATE case_truth SET status = 'archived' WHERE case_id = ?")
      .run(CASE_ID);

    const result = supersedeCorrection(getAdapter(), {
      old_correction_id: applyResult.correction_id,
      new_value_json: JSON.stringify({ status: 'removed' }),
      reason: 'r',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 's',
      now: NOW,
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.terminal_status',
    });
  });

  it('supersede chain: new correction can itself be superseded', () => {
    const old1 = applyInitialCorrection();
    const s1 = supersedeCorrection(getAdapter(), {
      old_correction_id: old1,
      new_value_json: JSON.stringify('mid'),
      reason: 'first supersede',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'mid',
      now: NOW,
    });
    if (s1.kind !== 'superseded') throw new Error('s1 failed');

    const s2 = supersedeCorrection(getAdapter(), {
      old_correction_id: s1.new_correction_id,
      new_value_json: JSON.stringify('final'),
      reason: 'second supersede',
      confirmed: true,
      confirmed_by: 'user-1',
      confirmation_summary: 'final',
      now: NOW,
    });
    expect(s2.kind).toBe('superseded');
    if (s2.kind !== 'superseded') return;

    // Verify chain: old1 → s1.new → s2.new
    const rows = getAdapter()
      .prepare('SELECT correction_id, is_lock_active, superseded_by FROM case_corrections')
      .all() as Array<{
      correction_id: string;
      is_lock_active: number;
      superseded_by: string | null;
    }>;

    expect(rows).toHaveLength(3);
    const map = new Map(rows.map((r) => [r.correction_id, r]));
    expect(map.get(old1)).toMatchObject({ is_lock_active: 0, superseded_by: s1.new_correction_id });
    expect(map.get(s1.new_correction_id)).toMatchObject({
      is_lock_active: 0,
      superseded_by: s2.new_correction_id,
    });
    expect(map.get(s2.new_correction_id)).toMatchObject({
      is_lock_active: 1,
      superseded_by: null,
    });
  });
});
