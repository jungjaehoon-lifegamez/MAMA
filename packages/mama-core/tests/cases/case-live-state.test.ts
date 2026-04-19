import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJSON } from '../../src/canonicalize.js';
import { getAdapter, type DatabaseAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  buildCaseFieldTargetRef,
  buildMembershipTargetRef,
  canonicalTargetRef,
} from '../../src/cases/target-ref.js';
import { writeCaseLiveStateFromEvent } from '../../src/cases/live-state.js';

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
    title: string;
    status: string;
    canonical_case_id: string | null;
    last_activity_at: string | null;
    created_at: string;
    updated_at: string;
  }>
): void {
  const adapter = getAdapter();
  const now = overrides.created_at ?? '2026-04-18T00:00:00.000Z';
  adapter
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, last_activity_at,
          canonical_case_id, created_at, updated_at
        )
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      overrides.title ?? overrides.case_id,
      overrides.status ?? 'active',
      overrides.last_activity_at ?? null,
      overrides.canonical_case_id ?? null,
      now,
      overrides.updated_at ?? now
    );
}

function insertMembership(
  overrides: Partial<{
    case_id: string;
    source_type: string;
    source_id: string;
    role: string | null;
    confidence: number | null;
    reason: string | null;
    status: string;
    added_by: string;
    added_at: string;
    updated_at: string;
    user_locked: 0 | 1;
  }>
): void {
  const adapter = getAdapter();
  const now = '2026-04-18T00:00:00.000Z';
  adapter
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status,
          added_by, added_at, updated_at, user_locked
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      overrides.source_type ?? 'event',
      overrides.source_id ?? 'event-1',
      overrides.role ?? null,
      overrides.confidence ?? null,
      overrides.reason ?? null,
      overrides.status ?? 'active',
      overrides.added_by ?? 'user-correction',
      overrides.added_at ?? now,
      overrides.updated_at ?? now,
      overrides.user_locked ?? 0
    );
}

function insertCorrectionLock(input: {
  correction_id: string;
  case_id: string;
  target_kind: 'case_field' | 'membership';
  target_ref_json: string;
  target_ref_hash: Buffer;
  field_name?: string | null;
}): void {
  const adapter = getAdapter();
  adapter
    .prepare(
      `
        INSERT INTO case_corrections (
          correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
          field_name, old_value_json, new_value_json, reason, is_lock_active,
          superseded_by, reverted_at, applied_by, applied_at
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'test lock', 1, NULL, NULL, 'user', ?)
      `
    )
    .run(
      input.correction_id,
      input.case_id,
      input.target_kind,
      input.target_ref_json,
      input.target_ref_hash,
      input.field_name ?? null,
      canonicalizeJSON({ locked: true }),
      '2026-04-18T00:00:00.000Z'
    );
}

function caseRow(caseId: string): { status: string; last_activity_at: string | null } {
  return getAdapter()
    .prepare('SELECT status, last_activity_at FROM case_truth WHERE case_id = ?')
    .get(caseId) as { status: string; last_activity_at: string | null };
}

describe('Story CF2.5: Lock-aware case live-state writer', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-live-state');
  });

  beforeEach(() => {
    resetCaseTables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('returns precompile_gap when case_id is missing', () => {
    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-missing',
      source_event_id: 'event-missing',
      source_type: 'event',
      last_activity_at: '2026-04-18T01:00:00.000Z',
    });

    expect(result).toEqual({
      kind: 'precompile_gap',
      code: 'case.precompile_gap',
      case_id: 'case-missing',
    });
  });

  it('precompile gap path does not update case_truth, case_memberships, or memory_events', () => {
    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-gap-no-write',
      source_event_id: 'event-gap-no-write',
      source_type: 'event',
      status: 'blocked',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      membership: {
        source_type: 'event',
        source_id: 'event-gap-no-write',
        confidence: 0.8,
        reason: 'gap test',
        status: 'active',
      },
    });

    expect(result.kind).toBe('precompile_gap');
    expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM case_truth').get()).toMatchObject({
      count: 0,
    });
    expect(
      getAdapter().prepare('SELECT COUNT(*) AS count FROM case_memberships').get()
    ).toMatchObject({ count: 0 });
    expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM memory_events').get()).toMatchObject(
      { count: 0 }
    );
  });

  it('first prepared SQL statement inside transaction is the case_truth gap gate', () => {
    const preparedSql: string[] = [];
    const fakeAdapter = {
      transaction<T>(fn: () => T): T {
        return fn();
      },
      prepare(sql: string) {
        preparedSql.push(sql.replace(/\s+/g, ' ').trim());
        return {
          get: () => undefined,
          all: () => [],
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        };
      },
    } as unknown as DatabaseAdapter;

    writeCaseLiveStateFromEvent(fakeAdapter, {
      case_id: 'case-first-sql',
      source_event_id: 'event-first-sql',
      source_type: 'event',
      last_activity_at: '2026-04-18T03:00:00.000Z',
    });

    expect(preparedSql[0]).toBe('SELECT case_id, status FROM case_truth WHERE case_id = ?');
  });

  it('writes status and last_activity_at when no locks exist', () => {
    insertCase({ case_id: 'case-live-write' });

    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-live-write',
      source_event_id: 'event-live-write',
      source_type: 'event',
      status: 'blocked',
      last_activity_at: '2026-04-18T04:00:00.000Z',
      now: '2026-04-18T04:00:01.000Z',
    });

    expect(result.kind).toBe('applied');
    expect(caseRow('case-live-write')).toEqual({
      status: 'blocked',
      last_activity_at: '2026-04-18T04:00:00.000Z',
    });
  });

  it("writes membership with added_by='memory-agent'", () => {
    insertCase({ case_id: 'case-membership-write' });

    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-membership-write',
      source_event_id: 'event-membership-write',
      source_type: 'event',
      membership: {
        source_type: 'event',
        source_id: 'event-membership-write',
        role: 'implementer',
        confidence: 0.82,
        reason: 'actor overlap',
        status: 'active',
      },
      now: '2026-04-18T05:00:00.000Z',
    });

    const row = getAdapter()
      .prepare(
        `
          SELECT role, confidence, reason, status, added_by, user_locked
          FROM case_memberships
          WHERE case_id = ? AND source_type = 'event' AND source_id = ?
        `
      )
      .get('case-membership-write', 'event-membership-write') as {
      role: string;
      confidence: number;
      reason: string;
      status: string;
      added_by: string;
      user_locked: number;
    };

    expect(result.kind).toBe('applied');
    expect(row).toMatchObject({
      role: 'implementer',
      confidence: 0.82,
      reason: 'actor overlap',
      status: 'active',
      added_by: 'memory-agent',
      user_locked: 0,
    });
  });

  it("does not reactivate a status='stale' membership", () => {
    insertCase({ case_id: 'case-stale-membership' });
    insertMembership({
      case_id: 'case-stale-membership',
      source_id: 'event-stale',
      status: 'stale',
      added_by: 'user-correction',
      user_locked: 0,
    });

    writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-stale-membership',
      source_event_id: 'event-stale',
      source_type: 'event',
      membership: {
        source_type: 'event',
        source_id: 'event-stale',
        confidence: 0.9,
        reason: 'seen again',
        status: 'active',
      },
    });

    const row = getAdapter()
      .prepare(
        `
          SELECT status, added_by
          FROM case_memberships
          WHERE case_id = ? AND source_type = 'event' AND source_id = ?
        `
      )
      .get('case-stale-membership', 'event-stale') as {
      status: string;
      added_by: string;
    };

    expect(row).toEqual({ status: 'stale', added_by: 'user-correction' });
  });

  it('skips locked status but writes unlocked last_activity_at', () => {
    insertCase({ case_id: 'case-partial-lock' });
    const statusTarget = canonicalTargetRef(buildCaseFieldTargetRef('status'));
    insertCorrectionLock({
      correction_id: 'corr-status-lock',
      case_id: 'case-partial-lock',
      target_kind: 'case_field',
      target_ref_json: statusTarget.json,
      target_ref_hash: statusTarget.hash,
      field_name: 'status',
    });

    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-partial-lock',
      source_event_id: 'event-partial-lock',
      source_type: 'event',
      status: 'blocked',
      last_activity_at: '2026-04-18T06:00:00.000Z',
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.skipped_targets).toHaveLength(1);
      expect(result.skipped_targets[0].correction_id).toBe('corr-status-lock');
    }
    expect(caseRow('case-partial-lock')).toEqual({
      status: 'active',
      last_activity_at: '2026-04-18T06:00:00.000Z',
    });
  });

  it('skips locked membership and emits case.fast_write_lock_skipped', () => {
    insertCase({ case_id: 'case-membership-lock' });
    const membershipTarget = canonicalTargetRef(
      buildMembershipTargetRef('event', 'event-membership-lock')
    );
    insertCorrectionLock({
      correction_id: 'corr-membership-lock',
      case_id: 'case-membership-lock',
      target_kind: 'membership',
      target_ref_json: membershipTarget.json,
      target_ref_hash: membershipTarget.hash,
    });

    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-membership-lock',
      source_event_id: 'event-membership-lock',
      source_type: 'event',
      membership: {
        source_type: 'event',
        source_id: 'event-membership-lock',
        confidence: 0.9,
        reason: 'locked membership',
        status: 'active',
      },
    });

    const membershipCount = getAdapter()
      .prepare('SELECT COUNT(*) AS count FROM case_memberships')
      .get() as { count: number };
    const eventRow = getAdapter()
      .prepare('SELECT event_type, actor, topic FROM memory_events')
      .get() as { event_type: string; actor: string; topic: string };

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.skipped_targets[0].correction_id).toBe('corr-membership-lock');
      expect(result.audit_event_ids).toHaveLength(1);
    }
    expect(membershipCount.count).toBe(0);
    expect(eventRow).toEqual({
      event_type: 'case.fast_write_lock_skipped',
      actor: 'memory_agent',
      topic: 'case:case-membership-lock',
    });
  });

  it('does not update merged, split, or archived case_truth rows', () => {
    for (const status of ['merged', 'split', 'archived']) {
      resetCaseTables();
      insertCase({ case_id: `case-terminal-${status}`, status });

      const result = writeCaseLiveStateFromEvent(getAdapter(), {
        case_id: `case-terminal-${status}`,
        source_event_id: `event-terminal-${status}`,
        source_type: 'event',
        last_activity_at: '2026-04-18T07:00:00.000Z',
      });

      expect(result).toMatchObject({
        kind: 'rejected',
        code: 'case.terminal_status',
        case_id: `case-terminal-${status}`,
      });
      expect(caseRow(`case-terminal-${status}`).last_activity_at).toBeNull();
    }
  });

  it('rejects proposed memory-agent statuses merged, split, and archived', () => {
    for (const status of ['merged', 'split', 'archived']) {
      resetCaseTables();
      insertCase({ case_id: `case-proposed-${status}` });

      const result = writeCaseLiveStateFromEvent(getAdapter(), {
        case_id: `case-proposed-${status}`,
        source_event_id: `event-proposed-${status}`,
        source_type: 'event',
        status: status as never,
      });

      expect(result).toMatchObject({
        kind: 'rejected',
        code: 'case.terminal_status',
        case_id: `case-proposed-${status}`,
      });
      expect(caseRow(`case-proposed-${status}`).status).toBe('active');
    }
  });

  it('honors user_locked=1 membership row', () => {
    insertCase({ case_id: 'case-user-locked-membership' });
    insertMembership({
      case_id: 'case-user-locked-membership',
      source_id: 'event-user-locked',
      role: 'reviewer',
      confidence: 0.2,
      reason: 'manual',
      status: 'candidate',
      added_by: 'user-correction',
      user_locked: 1,
    });

    writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-user-locked-membership',
      source_event_id: 'event-user-locked',
      source_type: 'event',
      membership: {
        source_type: 'event',
        source_id: 'event-user-locked',
        role: 'implementer',
        confidence: 0.95,
        reason: 'agent',
        status: 'active',
      },
    });

    const row = getAdapter()
      .prepare(
        `
          SELECT role, confidence, reason, status, added_by, user_locked
          FROM case_memberships
          WHERE case_id = ? AND source_id = ?
        `
      )
      .get('case-user-locked-membership', 'event-user-locked') as {
      role: string;
      confidence: number;
      reason: string;
      status: string;
      added_by: string;
      user_locked: number;
    };

    expect(row).toMatchObject({
      role: 'reviewer',
      confidence: 0.2,
      reason: 'manual',
      status: 'candidate',
      added_by: 'user-correction',
      user_locked: 1,
    });
  });

  it('skips survivor status write when an active status correction lock exists on a merged loser', () => {
    insertCase({ case_id: 'case-chain-survivor' });
    insertCase({
      case_id: 'case-chain-loser',
      status: 'merged',
      canonical_case_id: 'case-chain-survivor',
    });
    const statusTarget = canonicalTargetRef(buildCaseFieldTargetRef('status'));
    insertCorrectionLock({
      correction_id: 'corr-loser-status',
      case_id: 'case-chain-loser',
      target_kind: 'case_field',
      target_ref_json: statusTarget.json,
      target_ref_hash: statusTarget.hash,
      field_name: 'status',
    });

    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-chain-survivor',
      source_event_id: 'event-chain-status',
      source_type: 'event',
      status: 'blocked',
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.skipped_targets[0].correction_id).toBe('corr-loser-status');
    }
    expect(caseRow('case-chain-survivor').status).toBe('active');
  });

  it('skips survivor membership write when an active membership correction lock exists on a merged loser', () => {
    insertCase({ case_id: 'case-chain-membership-survivor' });
    insertCase({
      case_id: 'case-chain-membership-loser',
      status: 'merged',
      canonical_case_id: 'case-chain-membership-survivor',
    });
    const membershipTarget = canonicalTargetRef(
      buildMembershipTargetRef('event', 'event-chain-membership')
    );
    insertCorrectionLock({
      correction_id: 'corr-loser-membership',
      case_id: 'case-chain-membership-loser',
      target_kind: 'membership',
      target_ref_json: membershipTarget.json,
      target_ref_hash: membershipTarget.hash,
    });

    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-chain-membership-survivor',
      source_event_id: 'event-chain-membership',
      source_type: 'event',
      membership: {
        source_type: 'event',
        source_id: 'event-chain-membership',
        confidence: 0.88,
        reason: 'chain lock',
        status: 'active',
      },
    });

    const membershipCount = getAdapter()
      .prepare('SELECT COUNT(*) AS count FROM case_memberships')
      .get() as { count: number };

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.skipped_targets[0].correction_id).toBe('corr-loser-membership');
    }
    expect(membershipCount.count).toBe(0);
  });

  it('uses target_ref_hash BLOB comparison by creating lock via canonicalTargetRef', () => {
    insertCase({ case_id: 'case-hash-blob' });
    const statusTarget = canonicalTargetRef(buildCaseFieldTargetRef('status'));
    insertCorrectionLock({
      correction_id: 'corr-hash-blob',
      case_id: 'case-hash-blob',
      target_kind: 'case_field',
      target_ref_json: statusTarget.json,
      target_ref_hash: statusTarget.hash,
      field_name: 'status',
    });

    const result = writeCaseLiveStateFromEvent(getAdapter(), {
      case_id: 'case-hash-blob',
      source_event_id: 'event-hash-blob',
      source_type: 'event',
      status: 'blocked',
    });

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.skipped_targets).toEqual([
        {
          target_kind: 'case_field',
          target_ref_json: statusTarget.json,
          correction_id: 'corr-hash-blob',
        },
      ]);
    }
    expect(caseRow('case-hash-blob').status).toBe('active');
  });
});
