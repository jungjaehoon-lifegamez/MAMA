import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJSON } from '../../src/canonicalize.js';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { assembleCase } from '../../src/cases/store.js';
import { mergeCases, splitCase } from '../../src/cases/merge-split.js';

const NOW = '2026-04-18T05:00:00.000Z';
const LOSER_ID = '11111111-1111-4111-8111-111111111111';
const SURVIVOR_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_A = '44444444-4444-4444-8444-444444444444';
const CHILD_B = '55555555-5555-4555-8555-555555555555';

function resetTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM memory_events').run();
  adapter.prepare('DELETE FROM case_corrections').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_truth').run();
  adapter.prepare('DELETE FROM decision_entity_sources').run();
  adapter.prepare('DELETE FROM decisions').run();
}

function insertCase(input: {
  case_id: string;
  title?: string;
  status?: string;
  canonical_case_id?: string | null;
  split_from_case_id?: string | null;
}): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, canonical_case_id, split_from_case_id,
          scope_refs, confidence, created_at, updated_at
        )
        VALUES (?, NULL, ?, ?, ?, ?, '[]', 'high', ?, ?)
      `
    )
    .run(
      input.case_id,
      input.title ?? input.case_id,
      input.status ?? 'active',
      input.canonical_case_id ?? null,
      input.split_from_case_id ?? null,
      NOW,
      NOW
    );
}

function insertDecision(decisionId: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, user_involvement, status, created_at,
          updated_at
        )
        VALUES (?, 'case/merge-split', 'Seed decision', 'test', 0.9, 'approved', 'active', ?, ?)
      `
    )
    .run(decisionId, NOW, NOW);
}

function insertMembership(input: {
  case_id: string;
  source_id: string;
  status?: string;
  user_locked?: 0 | 1;
}): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status, added_by,
          added_at, updated_at, user_locked
        )
        VALUES (?, 'decision', ?, 'supporting', 0.8, 'seeded', ?, 'wiki-compiler', ?, ?, ?)
      `
    )
    .run(
      input.case_id,
      input.source_id,
      input.status ?? 'active',
      NOW,
      NOW,
      input.user_locked ?? 0
    );
}

function insertInactiveCorrection(caseId: string, correctionId: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO case_corrections (
          correction_id, case_id, target_kind, target_ref_json, target_ref_hash, field_name,
          old_value_json, new_value_json, reason, is_lock_active, superseded_by, reverted_at,
          applied_by, applied_at
        )
        VALUES (?, ?, 'case_field', ?, ?, 'status', ?, ?, 'seed audit', 0, NULL, NULL, 'user', ?)
      `
    )
    .run(
      correctionId,
      caseId,
      canonicalizeJSON({ kind: 'case_field', field: 'status' }),
      Buffer.alloc(32, 0x11),
      canonicalizeJSON('active'),
      canonicalizeJSON('blocked'),
      NOW
    );
}

function mergeInput(overrides: Record<string, unknown> = {}) {
  return {
    loser_case_id: LOSER_ID,
    survivor_case_id: SURVIVOR_ID,
    reason: 'User confirmed duplicate cases.',
    confirmed: true,
    confirmed_by: 'user-1',
    confirmation_summary: 'Loser belongs under survivor.',
    now: NOW,
    ...overrides,
  };
}

function splitInput(overrides: Record<string, unknown> = {}) {
  return {
    parent_case_id: PARENT_ID,
    children: [
      {
        title: 'Child A',
        membership_sources: [
          { source_type: 'decision', source_id: 'dec-split-a', remove_from_parent: true },
        ],
      },
      {
        title: 'Child B',
        membership_sources: [{ source_type: 'decision', source_id: 'dec-split-b' }],
      },
    ],
    trusted_child_case_ids: [CHILD_A, CHILD_B],
    reason: 'User confirmed separate workstreams.',
    confirmed: true,
    confirmed_by: 'user-1',
    confirmation_summary: 'Parent case should split into two child cases.',
    now: NOW,
    ...overrides,
  };
}

describe('Story CF2.9: HITL-only case merge and split', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-merge-split');
  });

  beforeEach(resetTables);

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('mergeCases', () => {
    it('rejects without confirmed=true', () => {
      const result = mergeCases(getAdapter(), mergeInput({ confirmed: false }) as never);

      expect(result).toMatchObject({
        kind: 'rejected',
        code: 'case.confirmation_required',
      });
    });

    it('rejects self merge', () => {
      insertCase({ case_id: LOSER_ID });

      const result = mergeCases(getAdapter(), mergeInput({ survivor_case_id: LOSER_ID }) as never);

      expect(result).toMatchObject({ kind: 'rejected', code: 'case.merge_self' });
    });

    it('missing loser or survivor returns precompile_gap', () => {
      insertCase({ case_id: SURVIVOR_ID });

      expect(mergeCases(getAdapter(), mergeInput())).toMatchObject({
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: LOSER_ID,
      });

      resetTables();
      insertCase({ case_id: LOSER_ID });
      expect(mergeCases(getAdapter(), mergeInput())).toMatchObject({
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: SURVIVOR_ID,
      });
    });

    it('rejects canonical cycle', () => {
      insertCase({ case_id: LOSER_ID });
      insertCase({ case_id: SURVIVOR_ID });
      insertCase({ case_id: '66666666-6666-4666-8666-666666666666' });
      // Build the cycle via UPDATE (bypasses insert-order FK constraint)
      getAdapter()
        .prepare('UPDATE case_truth SET canonical_case_id = ? WHERE case_id = ?')
        .run(SURVIVOR_ID, LOSER_ID);
      getAdapter()
        .prepare('UPDATE case_truth SET canonical_case_id = ? WHERE case_id = ?')
        .run(LOSER_ID, SURVIVOR_ID);

      const result = mergeCases(
        getAdapter(),
        mergeInput({ survivor_case_id: '66666666-6666-4666-8666-666666666666' })
      );

      expect(result).toMatchObject({ kind: 'rejected', code: 'case.merge_chain_cycle' });
    });

    it('sets loser merged, keeps loser memberships/corrections, and reads them through survivor', () => {
      insertCase({ case_id: LOSER_ID, title: 'Loser' });
      insertCase({ case_id: SURVIVOR_ID, title: 'Survivor' });
      insertDecision('dec-loser');
      insertMembership({ case_id: LOSER_ID, source_id: 'dec-loser' });
      insertInactiveCorrection(LOSER_ID, 'corr-loser-audit');

      const result = mergeCases(getAdapter(), mergeInput());

      expect(result).toMatchObject({
        kind: 'merged',
        loser_case_id: LOSER_ID,
        survivor_case_id: SURVIVOR_ID,
        audit_event_id: expect.any(String),
      });
      expect(
        getAdapter()
          .prepare('SELECT status, canonical_case_id FROM case_truth WHERE case_id = ?')
          .get(LOSER_ID)
      ).toMatchObject({ status: 'merged', canonical_case_id: SURVIVOR_ID });
      expect(
        getAdapter()
          .prepare('SELECT case_id FROM case_memberships WHERE source_id = ?')
          .get('dec-loser')
      ).toMatchObject({ case_id: LOSER_ID });
      expect(
        getAdapter()
          .prepare('SELECT case_id FROM case_corrections WHERE correction_id = ?')
          .get('corr-loser-audit')
      ).toMatchObject({ case_id: LOSER_ID });

      const survivorAssembly = assembleCase(getAdapter(), SURVIVOR_ID);
      expect(survivorAssembly.decisions.map((decision) => decision.id)).toContain('dec-loser');

      const loserAssembly = assembleCase(getAdapter(), LOSER_ID);
      expect(loserAssembly.case_id).toBe(SURVIVOR_ID);
      expect(loserAssembly.resolved_via_case_id).toBe(LOSER_ID);
      expect(loserAssembly.decisions.map((decision) => decision.id)).toContain('dec-loser');

      expect(getAdapter().prepare('SELECT event_type FROM memory_events').get()).toMatchObject({
        event_type: 'case.merged',
      });
      expect(
        getAdapter()
          .prepare(
            `
              SELECT COUNT(*) AS count
                FROM case_corrections
               WHERE case_id = ?
                 AND is_lock_active = 1
            `
          )
          .get(LOSER_ID)
      ).toMatchObject({ count: 0 });
      expect(
        getAdapter()
          .prepare(
            `
              SELECT COUNT(*) AS count
                FROM case_corrections
               WHERE case_id = ?
                 AND is_lock_active = 0
            `
          )
          .get(LOSER_ID)
      ).toMatchObject({ count: 2 });
    });

    it('writes merge state against resolved canonical ids when aliases are provided', () => {
      insertCase({ case_id: LOSER_ID, title: 'Canonical loser' });
      insertCase({ case_id: SURVIVOR_ID, title: 'Canonical survivor' });
      insertCase({
        case_id: '77777777-7777-4777-8777-777777777777',
        title: 'Loser alias',
        canonical_case_id: LOSER_ID,
      });
      insertCase({
        case_id: '88888888-8888-4888-8888-888888888888',
        title: 'Survivor alias',
        canonical_case_id: SURVIVOR_ID,
      });

      const result = mergeCases(
        getAdapter(),
        mergeInput({
          loser_case_id: '77777777-7777-4777-8777-777777777777',
          survivor_case_id: '88888888-8888-4888-8888-888888888888',
        }) as never
      );

      expect(result).toMatchObject({ kind: 'merged' });
      expect(
        getAdapter()
          .prepare('SELECT status, canonical_case_id FROM case_truth WHERE case_id = ?')
          .get(LOSER_ID)
      ).toMatchObject({ status: 'merged', canonical_case_id: SURVIVOR_ID });
      expect(
        getAdapter()
          .prepare('SELECT status FROM case_truth WHERE case_id = ?')
          .get('77777777-7777-4777-8777-777777777777')
      ).toMatchObject({ status: 'active' });
    });
  });

  describe('splitCase', () => {
    beforeEach(() => {
      insertCase({ case_id: PARENT_ID, title: 'Parent' });
      insertDecision('dec-split-a');
      insertDecision('dec-split-b');
      insertDecision('dec-split-stays');
      insertMembership({ case_id: PARENT_ID, source_id: 'dec-split-a' });
      insertMembership({ case_id: PARENT_ID, source_id: 'dec-split-b' });
      insertMembership({ case_id: PARENT_ID, source_id: 'dec-split-stays' });
    });

    it('rejects without confirmation and one-child split', () => {
      expect(splitCase(getAdapter(), splitInput({ confirmed: false }) as never)).toMatchObject({
        kind: 'rejected',
        code: 'case.confirmation_required',
      });

      expect(
        splitCase(
          getAdapter(),
          splitInput({
            children: [{ title: 'Only Child', membership_sources: [] }],
            trusted_child_case_ids: [CHILD_A],
          })
        )
      ).toMatchObject({ kind: 'rejected', code: 'case.split_requires_two_children' });
    });

    it('missing parent returns precompile_gap and terminal parent is rejected', () => {
      resetTables();

      expect(splitCase(getAdapter(), splitInput())).toMatchObject({
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: PARENT_ID,
      });

      insertCase({ case_id: PARENT_ID, status: 'archived' });
      expect(splitCase(getAdapter(), splitInput())).toMatchObject({
        kind: 'rejected',
        code: 'case.terminal_status',
      });
    });

    it('rejects caller-supplied child case_id and untrusted child ids', () => {
      expect(
        splitCase(
          getAdapter(),
          splitInput({
            children: [
              { title: 'Child A', case_id: 'case_bad', membership_sources: [] },
              { title: 'Child B', membership_sources: [] },
            ],
          }) as never
        )
      ).toMatchObject({ kind: 'rejected', code: 'case.child_id_not_trusted' });

      expect(
        splitCase(getAdapter(), splitInput({ trusted_child_case_ids: ['case_bad', CHILD_B] }))
      ).toMatchObject({ kind: 'rejected', code: 'case.child_id_not_trusted' });

      expect(
        splitCase(getAdapter(), splitInput({ trusted_child_case_ids: [CHILD_A] }))
      ).toMatchObject({ kind: 'rejected', code: 'case.child_id_count_mismatch' });
    });

    it('creates children, marks parent split, audits inactive correction, and moves memberships explicitly', () => {
      const result = splitCase(getAdapter(), splitInput());

      expect(result).toMatchObject({
        kind: 'split',
        parent_case_id: PARENT_ID,
        child_case_ids: [CHILD_A, CHILD_B],
        audit_event_id: expect.any(String),
      });
      for (const childId of [CHILD_A, CHILD_B]) {
        expect(childId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
        expect(childId.startsWith('case_')).toBe(false);
      }

      expect(
        getAdapter().prepare('SELECT status FROM case_truth WHERE case_id = ?').get(PARENT_ID)
      ).toMatchObject({ status: 'split' });
      expect(
        getAdapter()
          .prepare('SELECT split_from_case_id FROM case_truth WHERE case_id = ?')
          .get(CHILD_A)
      ).toMatchObject({ split_from_case_id: PARENT_ID });

      expect(
        getAdapter()
          .prepare(
            `
              SELECT status, user_locked
                FROM case_memberships
               WHERE case_id = ?
                 AND source_id = 'dec-split-a'
            `
          )
          .get(PARENT_ID)
      ).toMatchObject({ status: 'removed', user_locked: 1 });
      expect(
        getAdapter()
          .prepare(
            `
              SELECT status, user_locked
                FROM case_memberships
               WHERE case_id = ?
                 AND source_id = 'dec-split-b'
            `
          )
          .get(PARENT_ID)
      ).toMatchObject({ status: 'active', user_locked: 0 });
      expect(
        getAdapter()
          .prepare(
            `
              SELECT status, user_locked
                FROM case_memberships
               WHERE case_id = ?
                 AND source_id = 'dec-split-stays'
            `
          )
          .get(PARENT_ID)
      ).toMatchObject({ status: 'active', user_locked: 0 });
      expect(
        getAdapter()
          .prepare(
            `
              SELECT status, user_locked, added_by
                FROM case_memberships
               WHERE case_id = ?
                 AND source_id = 'dec-split-a'
            `
          )
          .get(CHILD_A)
      ).toMatchObject({ status: 'active', user_locked: 1, added_by: 'user-correction' });

      const correction = getAdapter()
        .prepare(
          `
            SELECT target_ref_json, is_lock_active
              FROM case_corrections
             WHERE case_id = ?
          `
        )
        .get(PARENT_ID) as { target_ref_json: string; is_lock_active: number };
      expect(JSON.parse(correction.target_ref_json)).toEqual({
        field: 'status',
        kind: 'case_field',
      });
      expect(correction.is_lock_active).toBe(0);

      expect(getAdapter().prepare('SELECT event_type FROM memory_events').get()).toMatchObject({
        event_type: 'case.split',
      });

      const parentAssembly = assembleCase(getAdapter(), PARENT_ID);
      expect(parentAssembly.linked_cases).toEqual(
        expect.arrayContaining([
          { case_id: CHILD_A, relation: 'split_into' },
          { case_id: CHILD_B, relation: 'split_into' },
        ])
      );
    });

    it('merge-split uses correction helper rather than raw case_corrections INSERT', () => {
      const source = readFileSync(resolve(process.cwd(), 'src/cases/merge-split.ts'), 'utf8');

      expect(source).not.toMatch(/INSERT\s+INTO\s+case_corrections/i);
      expect(source).toContain('insertCaseCorrectionLock');
    });
  });
});
