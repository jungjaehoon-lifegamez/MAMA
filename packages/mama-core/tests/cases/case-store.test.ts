import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { CaseMergeChainCycleError } from '../../src/entities/errors.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  assembleCase,
  enqueueCaseProposal,
  listActiveCorrectionsForCaseChain,
  listActiveMembershipsForCaseChain,
  listUnresolvedCaseProposals,
  resolveCanonicalCaseChain,
  upsertCaseTruthSlowFields,
  upsertExplicitCaseMemberships,
} from '../../src/cases/store.js';

function insertCase(
  overrides: Partial<{
    case_id: string;
    title: string;
    status: string;
    current_wiki_path: string | null;
    canonical_case_id: string | null;
    split_from_case_id: string | null;
    created_at: string;
    updated_at: string;
  }>
): void {
  const adapter = getAdapter();
  const now = new Date().toISOString();

  adapter
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, canonical_case_id,
          split_from_case_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      overrides.current_wiki_path ?? null,
      overrides.title ?? overrides.case_id,
      overrides.status ?? 'active',
      overrides.canonical_case_id ?? null,
      overrides.split_from_case_id ?? null,
      overrides.created_at ?? now,
      overrides.updated_at ?? now
    );
}

function updateCanonicalCase(
  caseId: string,
  canonicalCaseId: string | null,
  status = 'merged'
): void {
  const adapter = getAdapter();

  adapter
    .prepare(
      `
        UPDATE case_truth
        SET canonical_case_id = ?, status = ?, updated_at = ?
        WHERE case_id = ?
      `
    )
    .run(canonicalCaseId, status, new Date().toISOString(), caseId);
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
  const now = new Date().toISOString();

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
      overrides.source_type ?? 'decision',
      overrides.source_id ?? 'dec-X',
      overrides.role ?? null,
      overrides.confidence ?? null,
      overrides.reason ?? null,
      overrides.status ?? 'active',
      overrides.added_by ?? 'wiki-compiler',
      overrides.added_at ?? now,
      overrides.updated_at ?? now,
      overrides.user_locked ?? 0
    );
}

describe('Story CF1.7: Core case store and error surface', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-store');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: Canonical case chain resolution', () => {
    it('resolves an active case to itself', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-active-self', title: 'Active self' });

      const resolution = resolveCanonicalCaseChain(adapter, 'case-active-self');

      expect(resolution).toEqual({
        terminal_case_id: 'case-active-self',
        chain: ['case-active-self'],
        resolved_via_case_id: null,
      });
    });

    it('resolves a merged loser to the survivor and reports resolved_via_case_id', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-merge-survivor', title: 'Survivor' });
      insertCase({
        case_id: 'case-merge-loser',
        title: 'Loser',
        status: 'merged',
        canonical_case_id: 'case-merge-survivor',
      });

      const resolution = resolveCanonicalCaseChain(adapter, 'case-merge-loser');
      const assembly = assembleCase(adapter, 'case-merge-loser');

      expect(resolution.terminal_case_id).toBe('case-merge-survivor');
      expect(resolution.chain).toEqual(['case-merge-loser', 'case-merge-survivor']);
      expect(resolution.resolved_via_case_id).toBe('case-merge-loser');
      expect(assembly.case_id).toBe('case-merge-survivor');
      expect(assembly.resolved_via_case_id).toBe('case-merge-loser');
    });

    it('throws case.merge_chain_cycle when a canonical chain cycles', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-cycle-a', title: 'Cycle A' });
      insertCase({ case_id: 'case-cycle-b', title: 'Cycle B' });
      updateCanonicalCase('case-cycle-a', 'case-cycle-b');
      updateCanonicalCase('case-cycle-b', 'case-cycle-a');

      expect(() => resolveCanonicalCaseChain(adapter, 'case-cycle-a')).toThrow(
        CaseMergeChainCycleError
      );

      try {
        resolveCanonicalCaseChain(adapter, 'case-cycle-a');
      } catch (error) {
        expect((error as CaseMergeChainCycleError).code).toBe('case.merge_chain_cycle');
        expect((error as CaseMergeChainCycleError).context.case_id).toBe('case-cycle-a');
        expect((error as CaseMergeChainCycleError).context.chain).toEqual([
          'case-cycle-a',
          'case-cycle-b',
          'case-cycle-a',
        ]);
      }
    });

    it('throws case.merge_chain_cycle with depth payload when a 65-deep chain exceeds cap', () => {
      const adapter = getAdapter();

      for (let i = 64; i >= 0; i -= 1) {
        insertCase({
          case_id: `case-deep-${i}`,
          title: `Deep ${i}`,
          status: i === 64 ? 'active' : 'merged',
          canonical_case_id: i === 64 ? null : `case-deep-${i + 1}`,
        });
      }

      try {
        resolveCanonicalCaseChain(adapter, 'case-deep-0');
        throw new Error('Expected resolveCanonicalCaseChain to throw.');
      } catch (error) {
        expect(error).toBeInstanceOf(CaseMergeChainCycleError);
        expect((error as CaseMergeChainCycleError).code).toBe('case.merge_chain_cycle');
        expect((error as CaseMergeChainCycleError).context.detected_at_depth).toBe(65);
        expect((error as Error).message).toContain('depth 65');
      }
    });

    it('does not follow split_from_case_id during canonicalization', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-split-parent', title: 'Split parent' });
      insertCase({
        case_id: 'case-split-child',
        title: 'Split child',
        split_from_case_id: 'case-split-parent',
      });

      const resolution = resolveCanonicalCaseChain(adapter, 'case-split-child');

      expect(resolution.terminal_case_id).toBe('case-split-child');
      expect(resolution.chain).toEqual(['case-split-child']);
      expect(resolution.resolved_via_case_id).toBeNull();
    });
  });

  describe('AC #2: Case membership read and write semantics', () => {
    it('de-dupes duplicate memberships by user_locked first, then updated_at', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-dedupe-survivor', title: 'Dedupe survivor' });
      insertCase({
        case_id: 'case-dedupe-loser',
        title: 'Dedupe loser',
        status: 'merged',
        canonical_case_id: 'case-dedupe-survivor',
      });
      insertMembership({
        case_id: 'case-dedupe-survivor',
        source_type: 'decision',
        source_id: 'dec-X',
        role: 'compiler-newer',
        updated_at: '2026-04-17T12:00:00.000Z',
        user_locked: 0,
      });
      insertMembership({
        case_id: 'case-dedupe-loser',
        source_type: 'decision',
        source_id: 'dec-X',
        role: 'user-locked-older',
        updated_at: '2026-04-17T10:00:00.000Z',
        user_locked: 1,
      });

      const memberships = listActiveMembershipsForCaseChain(adapter, [
        'case-dedupe-loser',
        'case-dedupe-survivor',
      ]);

      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        source_type: 'decision',
        source_id: 'dec-X',
        role: 'user-locked-older',
        user_locked: true,
      });
    });

    it('does not overwrite user_locked=1 rows during wiki-compiler upsert', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-locked-membership', title: 'Locked membership' });
      insertMembership({
        case_id: 'case-locked-membership',
        source_type: 'decision',
        source_id: 'dec-locked',
        role: 'user-kept',
        confidence: 0.95,
        reason: 'user lock',
        added_by: 'user-correction',
        user_locked: 1,
      });

      upsertExplicitCaseMemberships(adapter, {
        case_id: 'case-locked-membership',
        rows: [
          {
            source_type: 'decision',
            source_id: 'dec-locked',
            role: 'compiler-overwrite',
            confidence: 0.2,
            reason: 'compiler pass',
          },
        ],
      });

      const row = adapter
        .prepare(
          `
            SELECT role, confidence, reason, added_by, user_locked
            FROM case_memberships
            WHERE case_id = ? AND source_type = 'decision' AND source_id = ?
          `
        )
        .get('case-locked-membership', 'dec-locked') as {
        role: string;
        confidence: number;
        reason: string;
        added_by: string;
        user_locked: number;
      };

      expect(row.role).toBe('user-kept');
      expect(row.confidence).toBe(0.95);
      expect(row.reason).toBe('user lock');
      expect(row.added_by).toBe('user-correction');
      expect(row.user_locked).toBe(1);
    });
  });

  describe('AC #3: Proposal queue idempotency', () => {
    it('returns the same proposal_id and inserted=false for unresolved duplicate fingerprints', () => {
      const adapter = getAdapter();

      const first = enqueueCaseProposal(adapter, {
        project: 'queue-project',
        proposal_kind: 'ambiguous_slug',
        proposed_payload: '{"slug":"same-case"}',
        stable_fingerprint_input: { slug: 'same-case', reason: 'ambiguous' },
      });

      const second = enqueueCaseProposal(adapter, {
        project: 'queue-project',
        proposal_kind: 'ambiguous_slug',
        proposed_payload: '{"slug":"same-case","rerun":true}',
        stable_fingerprint_input: { reason: 'ambiguous', slug: 'same-case' },
      });

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.proposal_id).toBe(first.proposal_id);
    });

    it('refreshes detected_at when a re-detected duplicate is enqueued (§5.7 L355)', async () => {
      const adapter = getAdapter();

      const first = enqueueCaseProposal(adapter, {
        project: 'refresh-project',
        proposal_kind: 'corrupt_frontmatter',
        proposed_payload: '{"path":"cases/corrupt.md"}',
        stable_fingerprint_input: { path: 'cases/corrupt.md' },
      });
      const firstDetected = adapter
        .prepare('SELECT detected_at FROM case_proposal_queue WHERE proposal_id = ?')
        .get(first.proposal_id) as { detected_at: string };

      // Wait one millisecond so ISO timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 2));

      const second = enqueueCaseProposal(adapter, {
        project: 'refresh-project',
        proposal_kind: 'corrupt_frontmatter',
        proposed_payload: '{"path":"cases/corrupt.md","rerun":true}',
        stable_fingerprint_input: { path: 'cases/corrupt.md' },
      });
      const secondDetected = adapter
        .prepare('SELECT detected_at FROM case_proposal_queue WHERE proposal_id = ?')
        .get(second.proposal_id) as { detected_at: string };

      expect(second.inserted).toBe(false);
      expect(second.proposal_id).toBe(first.proposal_id);
      expect(new Date(secondDetected.detected_at).getTime()).toBeGreaterThan(
        new Date(firstDetected.detected_at).getTime()
      );
    });
  });

  describe('AC #4: Coverage for remaining exported store helpers', () => {
    it('upsertCaseTruthSlowFields writes every spec §5.2 slow field and is idempotent', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-slow-fields', title: 'Slow fields target' });

      upsertCaseTruthSlowFields(adapter, {
        case_id: 'case-slow-fields',
        current_wiki_path: 'cases/slow-fields.md',
        title: 'Slow Fields',
        status_reason: 'in progress',
        primary_actors: JSON.stringify([{ entity_id: 'actor-1', role: 'owner' }]),
        blockers: JSON.stringify([{ text: 'pending decision' }]),
        confidence: 'high',
        scope_refs: JSON.stringify([{ kind: 'project', id: 'alpha' }]),
        wiki_path_history: JSON.stringify([
          { path: 'cases/old.md', valid_from: '2026-04-01', valid_to: '2026-04-17' },
        ]),
        compiled_at: '2026-04-17T00:00:00Z',
      });

      const row = adapter
        .prepare('SELECT * FROM case_truth WHERE case_id = ?')
        .get('case-slow-fields') as Record<string, unknown>;
      expect(row.current_wiki_path).toBe('cases/slow-fields.md');
      expect(row.title).toBe('Slow Fields');
      expect(row.status_reason).toBe('in progress');
      expect(row.confidence).toBe('high');
      expect(row.compiled_at).toBe('2026-04-17T00:00:00Z');

      // Spec §5.2 L196-197: wiki-compiler must NOT touch status / last_activity_at /
      // state_updated_at (those are memory-agent Phase 2 fast-write fields).
      // The default status from migration 039 is 'active'; after the slow-field
      // upsert it must remain 'active' and the fast-write timestamps stay NULL.
      expect(row.status).toBe('active');
      expect(row.last_activity_at).toBeNull();
      expect(row.state_updated_at).toBeNull();

      // Idempotent re-upsert with a different wiki path should update the path
      // without touching status/fast fields.
      upsertCaseTruthSlowFields(adapter, {
        case_id: 'case-slow-fields',
        current_wiki_path: 'cases/slow-fields-renamed.md',
        title: 'Slow Fields',
        compiled_at: '2026-04-17T01:00:00Z',
      });
      const afterRow = adapter
        .prepare(
          'SELECT current_wiki_path, status, last_activity_at FROM case_truth WHERE case_id = ?'
        )
        .get('case-slow-fields') as {
        current_wiki_path: string;
        status: string;
        last_activity_at: string | null;
      };
      expect(afterRow.current_wiki_path).toBe('cases/slow-fields-renamed.md');
      expect(afterRow.status).toBe('active');
      expect(afterRow.last_activity_at).toBeNull();
    });

    it('listActiveCorrectionsForCaseChain returns only active corrections across a canonical chain', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-chain-active' });
      insertCase({
        case_id: 'case-chain-loser',
        canonical_case_id: 'case-chain-active',
        status: 'merged',
      });

      const now = new Date().toISOString();
      const hash = (seed: string): Buffer => {
        // use SHA-256 via canonicalize/targetRefHash (available via cases/store),
        // but inline a small helper to avoid importing another module.
        return Buffer.concat([Buffer.alloc(32, seed.length & 0xff)]);
      };
      // Active correction on survivor
      adapter
        .prepare(
          `INSERT INTO case_corrections
             (correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
              new_value_json, reason, is_lock_active, applied_by, applied_at)
           VALUES (?, ?, 'case_field', ?, ?, ?, ?, 1, 'user', ?)`
        )
        .run(
          'corr-active-surv',
          'case-chain-active',
          '{"field":"status"}',
          hash('survivor'),
          '"blocked"',
          'r',
          now
        );
      // Active correction on loser (should surface via chain read)
      adapter
        .prepare(
          `INSERT INTO case_corrections
             (correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
              new_value_json, reason, is_lock_active, applied_by, applied_at)
           VALUES (?, ?, 'case_field', ?, ?, ?, ?, 1, 'user', ?)`
        )
        .run(
          'corr-active-loser',
          'case-chain-loser',
          '{"field":"title"}',
          hash('loserA'),
          '"New title"',
          'r',
          now
        );
      // Reverted (inactive) correction on loser — must be excluded
      adapter
        .prepare(
          `INSERT INTO case_corrections
             (correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
              new_value_json, reason, is_lock_active, applied_by, applied_at, reverted_at)
           VALUES (?, ?, 'case_field', ?, ?, ?, ?, 0, 'user', ?, ?)`
        )
        .run(
          'corr-reverted',
          'case-chain-loser',
          '{"field":"confidence"}',
          hash('revertedB'),
          '"low"',
          'r',
          now,
          now
        );

      const active = listActiveCorrectionsForCaseChain(adapter, [
        'case-chain-active',
        'case-chain-loser',
      ]);
      const ids = active.map((c) => c.correction_id).sort();
      expect(ids).toEqual(['corr-active-loser', 'corr-active-surv']);
    });

    it('listUnresolvedCaseProposals returns only unresolved rows ordered by detected_at ASC', async () => {
      const adapter = getAdapter();

      // Oldest unresolved
      enqueueCaseProposal(adapter, {
        project: 'list-project',
        proposal_kind: 'ambiguous_slug',
        proposed_payload: '{"slug":"alpha"}',
        stable_fingerprint_input: { slug: 'alpha', project: 'list-project' },
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      // Newer unresolved
      const newer = enqueueCaseProposal(adapter, {
        project: 'list-project',
        proposal_kind: 'ambiguous_slug',
        proposed_payload: '{"slug":"beta"}',
        stable_fingerprint_input: { slug: 'beta', project: 'list-project' },
      });
      // Resolved — should be filtered out
      const resolvedId = 'prop-resolved-list';
      const now = new Date().toISOString();
      adapter
        .prepare(
          `INSERT INTO case_proposal_queue
             (proposal_id, project, proposal_kind, proposed_payload, payload_fingerprint,
              conflicting_case_id, detected_at, resolved_at, resolution, resolution_note)
           VALUES (?, 'list-project', 'ambiguous_slug', ?, ?, NULL, ?, ?, 'rejected', NULL)`
        )
        .run(resolvedId, '{"slug":"gamma"}', Buffer.alloc(32, 0x42), now, now);

      const rows = listUnresolvedCaseProposals(adapter, 'list-project');
      const ids = rows.map((r) => r.proposal_id);
      expect(ids).toContain(newer.proposal_id);
      expect(ids).not.toContain(resolvedId);
      // detected_at ASC — oldest comes first, newer second
      const timestamps = rows.map((r) => new Date(r.detected_at).getTime());
      const sorted = [...timestamps].sort((a, b) => a - b);
      expect(timestamps).toEqual(sorted);
    });

    it('assembleCase resolves decisions, timeline events, observations, and active corrections via the chain', () => {
      const adapter = getAdapter();
      insertCase({ case_id: 'case-assemble-surv', title: 'Survivor' });
      insertCase({
        case_id: 'case-assemble-loser',
        canonical_case_id: 'case-assemble-surv',
        status: 'merged',
        title: 'Loser',
      });

      // Seed a decision referenced by the loser's membership
      const now = new Date().toISOString();
      adapter
        .prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, confidence, user_involvement, status, created_at, updated_at)
           VALUES ('dec-surv-1', 'project_alpha/topic', 'Ship read-only viewer', 'Phase 1 scope', 0.9, 'approved', 'active', ?, ?)`
        )
        .run(now, now);
      // Seed an entity + timeline event + observation to exercise bulk resolve
      adapter
        .prepare(
          `INSERT INTO entity_nodes (id, kind, preferred_label, status, created_at, updated_at)
           VALUES ('ent-surv', 'project', 'Alpha', 'active', unixepoch()*1000, unixepoch()*1000)`
        )
        .run();
      adapter
        .prepare(
          `INSERT INTO entity_timeline_events (id, entity_id, event_type, role, summary, observed_at, created_at)
           VALUES ('evt-surv-1', 'ent-surv', 'decision_made', 'observer', 'kickoff', unixepoch()*1000, unixepoch()*1000)`
        )
        .run();
      adapter
        .prepare(
          `INSERT INTO entity_timeline_events (id, entity_id, event_type, role, summary, observed_at, created_at)
           VALUES ('evt-surv-2', 'ent-surv', 'implementation_update', 'implementer', 'build shipped', unixepoch()*1000, unixepoch()*1000)`
        )
        .run();
      adapter
        .prepare(
          `INSERT INTO entity_observations
             (id, surface_form, normalized_form, related_surface_forms, extractor_version,
              source_connector, source_raw_record_id, source_locator, created_at)
           VALUES ('obs-surv-1', 'Alpha kickoff', 'alpha kickoff', '[]', 'test', 'slack',
                   'slack-msg-1', 'slack://alpha#msg1', unixepoch()*1000)`
        )
        .run();

      // Membership on the loser referencing each source kind
      upsertExplicitCaseMemberships(adapter, {
        case_id: 'case-assemble-loser',
        rows: [
          { source_type: 'decision', source_id: 'dec-surv-1', role: 'primary' },
          { source_type: 'event', source_id: 'evt-surv-1', role: 'supporting' },
          { source_type: 'event', source_id: 'evt-surv-2', role: null },
          { source_type: 'observation', source_id: 'obs-surv-1', role: 'supporting' },
        ],
      });

      // Active correction on the loser — should surface under survivor's view
      adapter
        .prepare(
          `INSERT INTO case_corrections
             (correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
              new_value_json, reason, is_lock_active, applied_by, applied_at)
           VALUES ('corr-assemble', 'case-assemble-loser', 'case_field', ?, ?, ?, ?, 1, 'user', ?)`
        )
        .run('{"field":"status"}', Buffer.alloc(32, 0xab), '"resolved"', 'user decision', now);

      const result = assembleCase(adapter, 'case-assemble-loser');
      expect(result.case_id).toBe('case-assemble-surv');
      expect(result.resolved_via_case_id).toBe('case-assemble-loser');
      expect(result.decisions.map((d) => d.id)).toContain('dec-surv-1');
      expect(result.timeline_events.map((e) => e.event_id)).toEqual(
        expect.arrayContaining(['evt-surv-1', 'evt-surv-2'])
      );
      const timelineRoleByEventId = new Map(
        result.timeline_events.map((event) => [event.event_id, event.role])
      );
      expect(timelineRoleByEventId.get('evt-surv-1')).toBe('supporting');
      expect(timelineRoleByEventId.get('evt-surv-2')).toBe('implementer');
      expect(result.recent_evidence.map((o) => o.observation_id)).toContain('obs-surv-1');
      expect(result.active_corrections.map((c) => c.correction_id)).toContain('corr-assemble');
      expect(result.wiki_page).toBeNull();
    });
  });
});
