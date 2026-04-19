import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function insertProposal(
  overrides: Partial<{
    proposal_id: string;
    project: string;
    proposal_kind: string;
    proposed_payload: string;
    payload_fingerprint: Buffer;
    conflicting_case_id: string | null;
    resolved_at: string | null;
    resolution: string | null;
  }> = {}
): void {
  const adapter = getAdapter();
  const now = new Date().toISOString();
  adapter
    .prepare(
      `INSERT INTO case_proposal_queue
         (proposal_id, project, proposal_kind, proposed_payload, payload_fingerprint,
          conflicting_case_id, detected_at, resolved_at, resolution, resolution_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      overrides.proposal_id ?? `prop-${Math.random().toString(16).slice(2, 10)}`,
      overrides.project ?? 'alpha',
      overrides.proposal_kind ?? 'ambiguous_slug',
      overrides.proposed_payload ?? '{"slug":"test"}',
      overrides.payload_fingerprint ?? sha256(overrides.proposed_payload ?? '{"slug":"test"}'),
      overrides.conflicting_case_id ?? null,
      now,
      overrides.resolved_at ?? null,
      overrides.resolution ?? null
    );
}

describe('case-first substrate — case_proposal_queue schema', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('case-proposal-queue-schema');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('creates the case_proposal_queue table', () => {
    const adapter = getAdapter();
    const row = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='case_proposal_queue'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('case_proposal_queue');
  });

  it('accepts every amended proposal_kind value', () => {
    const kinds = [
      'ambiguous_slug',
      'duplicate_frontmatter',
      'missing_frontmatter',
      'unknown_case_id',
      'stale_case_id',
      'merged_target',
      'archived_target',
      'lock_conflict',
      'corrupt_frontmatter',
      'quarantined_accepted_case',
    ];
    for (const kind of kinds) {
      const payload = `{"kind":"${kind}"}`;
      expect(() =>
        insertProposal({
          proposal_id: `prop-kind-${kind}`,
          proposal_kind: kind,
          proposed_payload: payload,
          payload_fingerprint: sha256(payload),
        })
      ).not.toThrow();
    }
  });

  it('rejects an unknown proposal_kind', () => {
    expect(() =>
      insertProposal({ proposal_kind: 'not_a_kind', proposal_id: 'prop-bad-kind' })
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects payload_fingerprint that is not exactly 32 bytes', () => {
    expect(() =>
      insertProposal({
        proposal_id: 'prop-bad-hash-short',
        payload_fingerprint: Buffer.from('short'),
      })
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      insertProposal({
        proposal_id: 'prop-bad-hash-long',
        payload_fingerprint: Buffer.alloc(64),
      })
    ).toThrow(/CHECK constraint/i);
  });

  it('partial UNIQUE: unresolved duplicate fingerprint is rejected', () => {
    const payload = '{"slug":"duplicate-case"}';
    const fp = sha256(payload);
    insertProposal({
      proposal_id: 'prop-dup-1',
      project: 'dup-proj',
      proposal_kind: 'ambiguous_slug',
      proposed_payload: payload,
      payload_fingerprint: fp,
      conflicting_case_id: 'case-X',
    });
    expect(() =>
      insertProposal({
        proposal_id: 'prop-dup-2',
        project: 'dup-proj',
        proposal_kind: 'ambiguous_slug',
        proposed_payload: payload,
        payload_fingerprint: fp,
        conflicting_case_id: 'case-X',
      })
    ).toThrow(/UNIQUE constraint/i);
  });

  it('partial UNIQUE: resolved duplicates are retained for audit', () => {
    const payload = '{"slug":"resolved-case"}';
    const fp = sha256(payload);
    const now = new Date().toISOString();
    // First row is resolved
    insertProposal({
      proposal_id: 'prop-resolved-1',
      project: 'audit-proj',
      proposal_kind: 'ambiguous_slug',
      proposed_payload: payload,
      payload_fingerprint: fp,
      conflicting_case_id: 'case-Y',
      resolved_at: now,
      resolution: 'rejected',
    });
    // Second resolved row with the same fingerprint is allowed (partial index
    // only dedupes where resolved_at IS NULL)
    expect(() =>
      insertProposal({
        proposal_id: 'prop-resolved-2',
        project: 'audit-proj',
        proposal_kind: 'ambiguous_slug',
        proposed_payload: payload,
        payload_fingerprint: fp,
        conflicting_case_id: 'case-Y',
        resolved_at: now,
        resolution: 'rejected',
      })
    ).not.toThrow();
    // An unresolved row with the same fingerprint is allowed once all prior
    // rows for the same composite key are resolved
    expect(() =>
      insertProposal({
        proposal_id: 'prop-new-active',
        project: 'audit-proj',
        proposal_kind: 'ambiguous_slug',
        proposed_payload: payload,
        payload_fingerprint: fp,
        conflicting_case_id: 'case-Y',
      })
    ).not.toThrow();
  });

  it('COALESCE allows dedup when conflicting_case_id is NULL', () => {
    const payload = '{"path":"corrupt.md"}';
    const fp = sha256(payload);
    insertProposal({
      proposal_id: 'prop-corrupt-1',
      project: 'corrupt-proj',
      proposal_kind: 'corrupt_frontmatter',
      proposed_payload: payload,
      payload_fingerprint: fp,
      conflicting_case_id: null,
    });
    expect(() =>
      insertProposal({
        proposal_id: 'prop-corrupt-2',
        project: 'corrupt-proj',
        proposal_kind: 'corrupt_frontmatter',
        proposed_payload: payload,
        payload_fingerprint: fp,
        conflicting_case_id: null,
      })
    ).toThrow(/UNIQUE constraint/i);
  });

});
