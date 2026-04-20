import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  backfillStructuralLinks,
  createCaseLink,
  isWikiTombstoneActive,
  listActiveCaseLinks,
  revokeCaseLink,
  sha256TombstoneFingerprint,
} from '../../src/cases/case-links.js';
import type { CaseLinkType } from '../../src/cases/case-links.js';

function resetCaseTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM memory_events').run();
  adapter.prepare('DELETE FROM case_links_revoked_wiki_tombstones').run();
  adapter.prepare('DELETE FROM case_links').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_corrections').run();
  adapter.prepare('DELETE FROM case_truth').run();
}

function insertCase(
  overrides: Partial<{
    case_id: string;
    title: string;
    status: string;
    canonical_case_id: string | null;
    split_from_case_id: string | null;
    current_wiki_path: string | null;
    created_at: string;
    updated_at: string;
  }>
): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
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

function tombstoneCount(): number {
  const row = getAdapter()
    .prepare('SELECT COUNT(*) AS count FROM case_links_revoked_wiki_tombstones')
    .get() as { count: number };
  return row.count;
}

function seedTombstone(input: {
  case_id_from: string;
  case_id_to: string;
  link_type: CaseLinkType;
}): Buffer {
  const fingerprint = sha256TombstoneFingerprint({
    source_case_id: input.case_id_from,
    target_case_id: input.case_id_to,
    link_type: input.link_type,
  });

  getAdapter()
    .prepare(
      `
        INSERT INTO case_links_revoked_wiki_tombstones (
          tombstone_id, case_id_from, case_id_to, link_type, source_ref_fingerprint,
          source_ref, created_at, created_by, revoke_reason, unsuppressed_at, unsuppressed_by
        )
        VALUES (?, ?, ?, ?, ?, 'wiki://case-a', '2026-04-18T00:00:00.000Z',
                'user:test', 'revoked wiki link', NULL, NULL)
      `
    )
    .run(
      `tomb-${input.case_id_from}-${input.case_id_to}-${input.link_type}`,
      input.case_id_from,
      input.case_id_to,
      input.link_type,
      fingerprint
    );

  return fingerprint;
}

describe('Task 13: Case links core store', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-links-store');
  });

  beforeEach(() => {
    resetCaseTables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('creates active links for every first-class link type', () => {
    insertCase({ case_id: 'case-a' });

    for (const [index, linkType] of [
      'related',
      'supersedes-case',
      'subcase-of',
      'blocked-by',
      'duplicate-of',
    ].entries() as IterableIterator<[number, CaseLinkType]>) {
      const targetId = `case-target-${index}`;
      insertCase({ case_id: targetId });

      const result = createCaseLink(getAdapter(), {
        link_id: `link-${linkType}`,
        case_id_from: 'case-a',
        case_id_to: targetId,
        link_type: linkType,
        created_by: 'user:test',
        now: `2026-04-18T00:0${index}:00.000Z`,
      });

      expect(result.kind).toBe('created');
    }

    const rows = listActiveCaseLinks(getAdapter(), 'case-a').links;
    expect(rows.map((row) => row.link_type).sort()).toEqual([
      'blocked-by',
      'duplicate-of',
      'related',
      'subcase-of',
      'supersedes-case',
    ]);
  });

  it('rejects self-links', () => {
    insertCase({ case_id: 'case-self' });

    const result = createCaseLink(getAdapter(), {
      case_id_from: 'case-self',
      case_id_to: 'case-self',
      link_type: 'related',
      created_by: 'user:test',
    });

    expect(result).toMatchObject({ kind: 'rejected', code: 'case.self_link' });
  });

  it('rejects terminal-status cases', () => {
    insertCase({ case_id: 'case-archived', status: 'archived' });
    insertCase({ case_id: 'case-active' });

    const result = createCaseLink(getAdapter(), {
      case_id_from: 'case-archived',
      case_id_to: 'case-active',
      link_type: 'related',
      created_by: 'user:test',
    });

    expect(result).toMatchObject({ kind: 'rejected', code: 'case.terminal_status' });
  });

  it('rejects duplicate active links', () => {
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });

    expect(
      createCaseLink(getAdapter(), {
        link_id: 'link-first',
        case_id_from: 'case-a',
        case_id_to: 'case-b',
        link_type: 'related',
        created_by: 'user:test',
      }).kind
    ).toBe('created');

    const duplicate = createCaseLink(getAdapter(), {
      link_id: 'link-second',
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'related',
      created_by: 'user:test',
    });

    expect(duplicate).toMatchObject({
      kind: 'rejected',
      code: 'case.correction_active_conflict',
    });
  });

  it('rejects manual create against an active wiki tombstone without explicit unsuppress', () => {
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });
    seedTombstone({ case_id_from: 'case-a', case_id_to: 'case-b', link_type: 'related' });

    const result = createCaseLink(getAdapter(), {
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'related',
      created_by: 'user:test',
      source_kind: 'manual',
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.wiki_tombstone_conflict',
    });
  });

  it('manual create with unsuppress_wiki_tombstone=true clears tombstone in the same transaction', () => {
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });
    seedTombstone({ case_id_from: 'case-a', case_id_to: 'case-b', link_type: 'related' });

    const result = createCaseLink(getAdapter(), {
      link_id: 'link-unsuppress',
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'related',
      created_by: 'user:test',
      source_kind: 'manual',
      unsuppress_wiki_tombstone: true,
      now: '2026-04-18T01:00:00.000Z',
    });

    expect(result.kind).toBe('created');
    expect(
      isWikiTombstoneActive(getAdapter(), {
        source_case_id: 'case-a',
        target_case_id: 'case-b',
        link_type: 'related',
      })
    ).toBe(false);

    const tombstone = getAdapter()
      .prepare(
        `
          SELECT unsuppressed_at, unsuppressed_by
          FROM case_links_revoked_wiki_tombstones
          LIMIT 1
        `
      )
      .get() as { unsuppressed_at: string; unsuppressed_by: string };

    expect(tombstone).toEqual({
      unsuppressed_at: '2026-04-18T01:00:00.000Z',
      unsuppressed_by: 'user:test',
    });
  });

  it('does not unsuppress a tombstone when creation is rejected by an active-link conflict', () => {
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });

    const existing = createCaseLink(getAdapter(), {
      link_id: 'link-existing',
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'related',
      created_by: 'user:test',
      source_kind: 'manual',
    });
    expect(existing.kind).toBe('created');

    seedTombstone({ case_id_from: 'case-a', case_id_to: 'case-b', link_type: 'related' });

    const result = createCaseLink(getAdapter(), {
      link_id: 'link-conflict-unsuppress',
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'related',
      created_by: 'user:test',
      source_kind: 'manual',
      unsuppress_wiki_tombstone: true,
      now: '2026-04-18T01:30:00.000Z',
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'case.correction_active_conflict',
    });
    expect(
      isWikiTombstoneActive(getAdapter(), {
        source_case_id: 'case-a',
        target_case_id: 'case-b',
        link_type: 'related',
      })
    ).toBe(true);
  });

  it('revoking a wiki_compiler link writes a durable tombstone', () => {
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });

    const created = createCaseLink(getAdapter(), {
      link_id: 'link-wiki',
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'related',
      created_by: 'wiki',
      source_kind: 'wiki_compiler',
      source_ref: 'Cases/Old Title.md#related',
      now: '2026-04-18T00:00:00.000Z',
    });

    expect(created.kind).toBe('created');

    const revoked = revokeCaseLink(getAdapter(), {
      link_id: 'link-wiki',
      revoked_by: 'user:test',
      revoke_reason: 'not related',
      now: '2026-04-18T01:00:00.000Z',
    });

    expect(revoked).toEqual({ kind: 'revoked', link_id: 'link-wiki' });
    expect(tombstoneCount()).toBe(1);

    const tombstone = getAdapter()
      .prepare(
        `
          SELECT source_ref_fingerprint, source_ref, created_by, revoke_reason
          FROM case_links_revoked_wiki_tombstones
          WHERE case_id_from = 'case-a' AND case_id_to = 'case-b'
        `
      )
      .get() as {
      source_ref_fingerprint: Buffer;
      source_ref: string;
      created_by: string;
      revoke_reason: string;
    };

    expect(tombstone.source_ref_fingerprint.toString('hex')).toBe(
      created.kind === 'created' ? created.source_ref_fingerprint_hex : ''
    );
    expect(tombstone.source_ref).toBe('Cases/Old Title.md#related');
    expect(tombstone.created_by).toBe('user:test');
    expect(tombstone.revoke_reason).toBe('not related');
  });

  it('tombstone fingerprint is stable across path and title changes', () => {
    insertCase({
      case_id: 'case-a',
      title: 'Old Title',
      current_wiki_path: 'Cases/Old Title.md',
    });
    insertCase({
      case_id: 'case-b',
      title: 'Target',
      current_wiki_path: 'Cases/Target.md',
    });

    const before = sha256TombstoneFingerprint({
      source_case_id: 'case-a',
      target_case_id: 'case-b',
      link_type: 'related',
    });

    getAdapter()
      .prepare(
        `
          UPDATE case_truth
          SET title = 'New Title',
              current_wiki_path = 'Cases/New Title.md',
              updated_at = '2026-04-18T02:00:00.000Z'
          WHERE case_id = 'case-a'
        `
      )
      .run();

    const after = sha256TombstoneFingerprint({
      source_case_id: 'case-a',
      target_case_id: 'case-b',
      link_type: 'related',
    });

    expect(after.toString('hex')).toBe(before.toString('hex'));
  });

  it('revoking a manual link does not write a tombstone', () => {
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });

    createCaseLink(getAdapter(), {
      link_id: 'link-manual',
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'blocked-by',
      created_by: 'user:test',
      source_kind: 'manual',
    });

    const revoked = revokeCaseLink(getAdapter(), {
      link_id: 'link-manual',
      revoked_by: 'user:test',
      revoke_reason: 'resolved',
    });

    expect(revoked).toEqual({ kind: 'revoked', link_id: 'link-manual' });
    expect(tombstoneCount()).toBe(0);
  });

  it('listActiveCaseLinks returns chain-aware loser links from the survivor view', () => {
    insertCase({ case_id: 'case-survivor' });
    insertCase({ case_id: 'case-loser' });
    insertCase({ case_id: 'case-target' });

    createCaseLink(getAdapter(), {
      link_id: 'link-before-merge',
      case_id_from: 'case-loser',
      case_id_to: 'case-target',
      link_type: 'related',
      created_by: 'user:test',
      now: '2026-04-18T00:00:00.000Z',
    });

    getAdapter()
      .prepare(
        `
          UPDATE case_truth
          SET status = 'merged', canonical_case_id = 'case-survivor'
          WHERE case_id = 'case-loser'
        `
      )
      .run();

    const result = listActiveCaseLinks(getAdapter(), 'case-survivor');

    expect(result.terminal_case_id).toBe('case-survivor');
    expect(result.resolved_via_case_id).toBe(null);
    expect(result.chain).toEqual(['case-survivor', 'case-loser']);
    expect(result.links.map((link) => link.link_id)).toEqual(['link-before-merge']);
  });

  it('orders active links by created_at DESC, link_id ASC', () => {
    insertCase({ case_id: 'case-a' });
    insertCase({ case_id: 'case-b' });
    insertCase({ case_id: 'case-c' });
    insertCase({ case_id: 'case-d' });

    createCaseLink(getAdapter(), {
      link_id: 'link-b',
      case_id_from: 'case-a',
      case_id_to: 'case-b',
      link_type: 'related',
      created_by: 'user:test',
      now: '2026-04-18T02:00:00.000Z',
    });
    createCaseLink(getAdapter(), {
      link_id: 'link-a',
      case_id_from: 'case-a',
      case_id_to: 'case-c',
      link_type: 'related',
      created_by: 'user:test',
      now: '2026-04-18T02:00:00.000Z',
    });
    createCaseLink(getAdapter(), {
      link_id: 'link-c',
      case_id_from: 'case-a',
      case_id_to: 'case-d',
      link_type: 'related',
      created_by: 'user:test',
      now: '2026-04-18T01:00:00.000Z',
    });

    expect(listActiveCaseLinks(getAdapter(), 'case-a').links.map((link) => link.link_id)).toEqual([
      'link-a',
      'link-b',
      'link-c',
    ]);
  });

  it('backfills duplicate-of and subcase-of structural links idempotently', () => {
    insertCase({ case_id: 'case-survivor' });
    insertCase({
      case_id: 'case-loser',
      status: 'merged',
      canonical_case_id: 'case-survivor',
    });
    insertCase({ case_id: 'case-parent' });
    insertCase({
      case_id: 'case-child',
      status: 'split',
      split_from_case_id: 'case-parent',
    });

    expect(backfillStructuralLinks(getAdapter())).toEqual({
      duplicate_of_inserted: 1,
      subcase_of_inserted: 1,
    });
    expect(backfillStructuralLinks(getAdapter())).toEqual({
      duplicate_of_inserted: 0,
      subcase_of_inserted: 0,
    });

    const rows = getAdapter()
      .prepare(
        `
          SELECT case_id_from, case_id_to, link_type, source_kind
          FROM case_links
          ORDER BY link_id ASC
        `
      )
      .all();

    expect(rows).toEqual([
      {
        case_id_from: 'case-loser',
        case_id_to: 'case-survivor',
        link_type: 'duplicate-of',
        source_kind: 'system_backfill',
      },
      {
        case_id_from: 'case-child',
        case_id_to: 'case-parent',
        link_type: 'subcase-of',
        source_kind: 'system_backfill',
      },
    ]);
  });
});
