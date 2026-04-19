import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJSON } from '../../src/canonicalize.js';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  pinCaseMembership,
  promoteCaseSource,
  unpinCaseMembership,
} from '../../src/cases/composition-overrides.js';

function resetCaseTables(): void {
  const adapter = getAdapter();
  adapter.prepare('PRAGMA foreign_keys = OFF').run();
  adapter.prepare('DELETE FROM memory_events').run();
  const tables = adapter
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name LIKE 'case_%'
        ORDER BY name DESC
      `
    )
    .all() as Array<{ name: string }>;
  for (const table of tables) {
    adapter.prepare(`DELETE FROM "${table.name}"`).run();
  }
  adapter.prepare('PRAGMA foreign_keys = ON').run();
}

function insertCase(
  overrides: Partial<{
    case_id: string;
    title: string;
    status: string;
    canonical_case_id: string | null;
    created_at: string;
    updated_at: string;
  }>
): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, title, status, canonical_case_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      overrides.title ?? overrides.case_id,
      overrides.status ?? 'active',
      overrides.canonical_case_id ?? null,
      overrides.created_at ?? now,
      overrides.updated_at ?? now
    );
}

function insertMembership(input: {
  case_id: string;
  source_type?: 'decision' | 'event' | 'observation' | 'artifact';
  source_id: string;
  status?: string;
  reason?: string | null;
  user_locked?: 0 | 1;
  assignment_strategy?: string | null;
}): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status,
          added_by, added_at, updated_at, user_locked, assignment_strategy
        )
        VALUES (?, ?, ?, NULL, 0.9, ?, ?, 'wiki-compiler', ?, ?, ?, ?)
      `
    )
    .run(
      input.case_id,
      input.source_type ?? 'decision',
      input.source_id,
      input.reason ?? null,
      input.status ?? 'active',
      now,
      now,
      input.user_locked ?? 0,
      input.assignment_strategy ?? null
    );
}

function membershipRow(
  caseId: string,
  sourceId: string
): {
  user_locked: number;
  assignment_strategy: string | null;
  reason: string | null;
  status: string;
} {
  return getAdapter()
    .prepare(
      `
        SELECT user_locked, assignment_strategy, reason, status
        FROM case_memberships
        WHERE case_id = ? AND source_id = ?
      `
    )
    .get(caseId, sourceId) as {
    user_locked: number;
    assignment_strategy: string | null;
    reason: string | null;
    status: string;
  };
}

describe('Task 14: Membership pin and source promotion core helpers', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-composition-overrides');
  });

  beforeEach(() => {
    resetCaseTables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('pin sets user_locked=1 and assignment_strategy=manual-pin', () => {
    insertCase({ case_id: 'case-pin' });
    insertMembership({ case_id: 'case-pin', source_id: 'dec-pin', reason: 'initial reason' });

    const result = pinCaseMembership(getAdapter(), {
      case_id: 'case-pin',
      source_type: 'decision',
      source_id: 'dec-pin',
      pinned_by: 'user:test',
      reason: 'keep this source',
      now: '2026-04-18T01:00:00.000Z',
    });

    expect(result.kind).toBe('pinned');
    expect(membershipRow('case-pin', 'dec-pin')).toMatchObject({
      user_locked: 1,
      assignment_strategy: 'manual-pin',
      status: 'active',
    });
    expect(membershipRow('case-pin', 'dec-pin').reason).toContain('keep this source');
  });

  it('replaces an existing trailing manual-pin line instead of appending duplicates', () => {
    insertCase({ case_id: 'case-pin-reason' });
    insertMembership({
      case_id: 'case-pin-reason',
      source_id: 'dec-pin-reason',
      reason: 'initial reason\nmanual-pin: old choice',
      user_locked: 1,
      assignment_strategy: 'manual-pin',
    });

    const result = pinCaseMembership(getAdapter(), {
      case_id: 'case-pin-reason',
      source_type: 'decision',
      source_id: 'dec-pin-reason',
      pinned_by: 'user:test',
      reason: 'new choice',
      now: '2026-04-18T01:00:00.000Z',
    });

    expect(result.kind).toBe('pinned');
    expect(membershipRow('case-pin-reason', 'dec-pin-reason').reason).toBe(
      'initial reason\nmanual-pin: new choice'
    );
  });

  it('unpin clears user_locked', () => {
    insertCase({ case_id: 'case-unpin' });
    insertMembership({
      case_id: 'case-unpin',
      source_id: 'dec-unpin',
      user_locked: 1,
      assignment_strategy: 'manual-pin',
    });

    const result = unpinCaseMembership(getAdapter(), {
      case_id: 'case-unpin',
      source_type: 'decision',
      source_id: 'dec-unpin',
      unpinned_by: 'user:test',
      reason: 'release lock',
    });

    expect(result.kind).toBe('unpinned');
    expect(membershipRow('case-unpin', 'dec-unpin').user_locked).toBe(0);
  });

  it('pin rejects stale membership', () => {
    insertCase({ case_id: 'case-stale' });
    insertMembership({ case_id: 'case-stale', source_id: 'dec-stale', status: 'stale' });

    const result = pinCaseMembership(getAdapter(), {
      case_id: 'case-stale',
      source_type: 'decision',
      source_id: 'dec-stale',
      pinned_by: 'user:test',
      reason: 'cannot pin stale',
    });

    expect(result).toMatchObject({ kind: 'rejected', code: 'case.membership_stale' });
  });

  it('pin rejects terminal case', () => {
    insertCase({ case_id: 'case-archived', status: 'archived' });
    insertMembership({ case_id: 'case-archived', source_id: 'dec-archived' });

    const result = pinCaseMembership(getAdapter(), {
      case_id: 'case-archived',
      source_type: 'decision',
      source_id: 'dec-archived',
      pinned_by: 'user:test',
      reason: 'terminal',
    });

    expect(result).toMatchObject({ kind: 'rejected', code: 'case.terminal_status' });
  });

  it('promote decision sets canonical_decision_id and pins membership', () => {
    insertCase({ case_id: 'case-promote-decision' });
    insertMembership({ case_id: 'case-promote-decision', source_id: 'dec-promoted' });

    const result = promoteCaseSource(getAdapter(), {
      case_id: 'case-promote-decision',
      source_type: 'decision',
      source_id: 'dec-promoted',
      promoted_by: 'user:test',
      reason: 'canonical decision',
      now: '2026-04-18T01:00:00.000Z',
    });

    expect(result).toMatchObject({
      kind: 'promoted',
      canonical_decision_id: 'dec-promoted',
      canonical_event_id: null,
    });

    const row = getAdapter()
      .prepare(
        `
          SELECT canonical_decision_id, canonical_event_id, promoted_by, promotion_reason
          FROM case_truth
          WHERE case_id = 'case-promote-decision'
        `
      )
      .get() as {
      canonical_decision_id: string | null;
      canonical_event_id: string | null;
      promoted_by: string;
      promotion_reason: string;
    };

    expect(row).toEqual({
      canonical_decision_id: 'dec-promoted',
      canonical_event_id: null,
      promoted_by: 'user:test',
      promotion_reason: 'canonical decision',
    });
    expect(membershipRow('case-promote-decision', 'dec-promoted').user_locked).toBe(1);
  });

  it('promote event sets canonical_event_id and pins membership', () => {
    insertCase({ case_id: 'case-promote-event' });
    insertMembership({
      case_id: 'case-promote-event',
      source_type: 'event',
      source_id: 'evt-promoted',
    });

    const result = promoteCaseSource(getAdapter(), {
      case_id: 'case-promote-event',
      source_type: 'event',
      source_id: 'evt-promoted',
      promoted_by: 'user:test',
      reason: 'canonical event',
    });

    expect(result).toMatchObject({
      kind: 'promoted',
      canonical_decision_id: null,
      canonical_event_id: 'evt-promoted',
    });
    expect(membershipRow('case-promote-event', 'evt-promoted').user_locked).toBe(1);
  });

  it('reconfirm tokens remain valid even when the confirmation call uses a later timestamp', () => {
    insertCase({ case_id: 'case-promote-reconfirm' });
    insertMembership({ case_id: 'case-promote-reconfirm', source_id: 'dec-reconfirm' });
    const previousSecret = process.env.MAMA_RECONFIRM_TOKEN_SECRET;
    process.env.MAMA_RECONFIRM_TOKEN_SECRET = Buffer.alloc(32, 9).toString('hex');

    try {
      const first = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-reconfirm',
        source_type: 'decision',
        source_id: 'dec-reconfirm',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        session_id: 'turn-promote',
        now: '2026-04-18T01:00:00.000Z',
      });

      expect(first.kind).toBe('requires_reconfirm');
      if (first.kind !== 'requires_reconfirm') {
        throw new Error('Expected reconfirm result');
      }

      const confirmed = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-reconfirm',
        source_type: 'decision',
        source_id: 'dec-reconfirm',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        reconfirm_token: first.reconfirm_token,
        session_id: 'turn-promote',
        now: '2026-04-18T01:05:00.000Z',
      });

      expect(confirmed).toMatchObject({
        kind: 'promoted',
        canonical_decision_id: 'dec-reconfirm',
      });
    } finally {
      if (previousSecret === undefined) {
        delete process.env.MAMA_RECONFIRM_TOKEN_SECRET;
      } else {
        process.env.MAMA_RECONFIRM_TOKEN_SECRET = previousSecret;
      }
    }
  });

  it('falls back to a fresh reconfirm flow when replay uses a stale consumed token', () => {
    insertCase({ case_id: 'case-promote-replay' });
    insertMembership({ case_id: 'case-promote-replay', source_id: 'dec-replay' });
    const previousSecret = process.env.MAMA_RECONFIRM_TOKEN_SECRET;
    process.env.MAMA_RECONFIRM_TOKEN_SECRET = Buffer.alloc(32, 9).toString('hex');

    try {
      const first = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-replay',
        source_type: 'decision',
        source_id: 'dec-replay',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        session_id: 'turn-promote',
        now: '2026-04-18T01:00:00.000Z',
      });
      expect(first.kind).toBe('requires_reconfirm');
      if (first.kind !== 'requires_reconfirm') {
        throw new Error('Expected reconfirm result');
      }

      const confirmed = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-replay',
        source_type: 'decision',
        source_id: 'dec-replay',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        reconfirm_token: first.reconfirm_token,
        session_id: 'turn-promote',
        now: '2026-04-18T01:05:00.000Z',
      });
      expect(confirmed.kind).toBe('promoted');

      const replay = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-replay',
        source_type: 'decision',
        source_id: 'dec-replay',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        reconfirm_token: first.reconfirm_token,
        session_id: 'turn-promote',
        now: '2026-04-18T01:06:00.000Z',
      });

      expect(replay.kind).toBe('requires_reconfirm');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.MAMA_RECONFIRM_TOKEN_SECRET;
      } else {
        process.env.MAMA_RECONFIRM_TOKEN_SECRET = previousSecret;
      }
    }
  });

  it('falls back to a new reconfirm flow when the token is expired', () => {
    insertCase({ case_id: 'case-promote-expired' });
    insertMembership({ case_id: 'case-promote-expired', source_id: 'dec-expired' });
    const previousSecret = process.env.MAMA_RECONFIRM_TOKEN_SECRET;
    process.env.MAMA_RECONFIRM_TOKEN_SECRET = Buffer.alloc(32, 9).toString('hex');

    try {
      const first = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-expired',
        source_type: 'decision',
        source_id: 'dec-expired',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        session_id: 'turn-promote',
        now: '2026-04-18T01:00:00.000Z',
      });
      expect(first.kind).toBe('requires_reconfirm');
      if (first.kind !== 'requires_reconfirm') {
        throw new Error('Expected reconfirm result');
      }

      const expired = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-expired',
        source_type: 'decision',
        source_id: 'dec-expired',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        reconfirm_token: first.reconfirm_token,
        session_id: 'turn-promote',
        now: '2026-04-18T02:00:00.000Z',
      });

      expect(expired.kind).toBe('requires_reconfirm');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.MAMA_RECONFIRM_TOKEN_SECRET;
      } else {
        process.env.MAMA_RECONFIRM_TOKEN_SECRET = previousSecret;
      }
    }
  });

  it('falls back to a new reconfirm flow when the token signature is tampered', () => {
    insertCase({ case_id: 'case-promote-tampered' });
    insertMembership({ case_id: 'case-promote-tampered', source_id: 'dec-tampered' });
    const previousSecret = process.env.MAMA_RECONFIRM_TOKEN_SECRET;
    process.env.MAMA_RECONFIRM_TOKEN_SECRET = Buffer.alloc(32, 9).toString('hex');

    try {
      const first = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-tampered',
        source_type: 'decision',
        source_id: 'dec-tampered',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        session_id: 'turn-promote',
        now: '2026-04-18T01:00:00.000Z',
      });
      expect(first.kind).toBe('requires_reconfirm');
      if (first.kind !== 'requires_reconfirm') {
        throw new Error('Expected reconfirm result');
      }

      const token = first.reconfirm_token.slice(0, -1) + (first.reconfirm_token.endsWith('A') ? 'B' : 'A');
      const tampered = promoteCaseSource(getAdapter(), {
        case_id: 'case-promote-tampered',
        source_type: 'decision',
        source_id: 'dec-tampered',
        promoted_by: 'user:test',
        reason: 'needs reconfirm',
        expected_current_value_json: canonicalizeJSON({
          promotion: { canonical_decision_id: 'dec-old', canonical_event_id: null },
        }),
        reconfirm_token: token,
        session_id: 'turn-promote',
        now: '2026-04-18T01:05:00.000Z',
      });

      expect(tampered.kind).toBe('requires_reconfirm');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.MAMA_RECONFIRM_TOKEN_SECRET;
      } else {
        process.env.MAMA_RECONFIRM_TOKEN_SECRET = previousSecret;
      }
    }
  });

  it('promote rejects observation with case.promote_invalid_source_type', () => {
    insertCase({ case_id: 'case-observation' });
    insertMembership({
      case_id: 'case-observation',
      source_type: 'observation',
      source_id: 'obs-1',
    });

    const result = promoteCaseSource(getAdapter(), {
      case_id: 'case-observation',
      source_type: 'observation',
      source_id: 'obs-1',
      promoted_by: 'user:test',
      reason: 'invalid',
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.promote_invalid_source_type',
    });
  });

  it('promote rejects non-active source with case.promote_source_not_active', () => {
    insertCase({ case_id: 'case-candidate' });
    insertMembership({
      case_id: 'case-candidate',
      source_type: 'decision',
      source_id: 'dec-candidate',
      status: 'candidate',
    });

    const result = promoteCaseSource(getAdapter(), {
      case_id: 'case-candidate',
      source_type: 'decision',
      source_id: 'dec-candidate',
      promoted_by: 'user:test',
      reason: 'not active',
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.promote_source_not_active',
    });
  });

  it('promote rejects terminal case', () => {
    insertCase({ case_id: 'case-split', status: 'split' });
    insertMembership({ case_id: 'case-split', source_id: 'dec-split' });

    const result = promoteCaseSource(getAdapter(), {
      case_id: 'case-split',
      source_type: 'decision',
      source_id: 'dec-split',
      promoted_by: 'user:test',
      reason: 'terminal',
    });

    expect(result).toMatchObject({ kind: 'rejected', code: 'case.terminal_status' });
  });

  it('merge chain lookup allows promoting a source on loser row to survivor', () => {
    insertCase({ case_id: 'case-survivor' });
    insertCase({
      case_id: 'case-loser',
      status: 'merged',
      canonical_case_id: 'case-survivor',
    });
    insertMembership({ case_id: 'case-loser', source_id: 'dec-on-loser' });

    const result = promoteCaseSource(getAdapter(), {
      case_id: 'case-survivor',
      source_type: 'decision',
      source_id: 'dec-on-loser',
      promoted_by: 'user:test',
      reason: 'canonical source survived merge',
    });

    expect(result).toMatchObject({
      kind: 'promoted',
      terminal_case_id: 'case-survivor',
      membership_case_id: 'case-loser',
      canonical_decision_id: 'dec-on-loser',
    });

    const survivor = getAdapter()
      .prepare('SELECT canonical_decision_id FROM case_truth WHERE case_id = ?')
      .get('case-survivor') as { canonical_decision_id: string | null };
    expect(survivor.canonical_decision_id).toBe('dec-on-loser');
    expect(membershipRow('case-loser', 'dec-on-loser').user_locked).toBe(1);
  });
});
