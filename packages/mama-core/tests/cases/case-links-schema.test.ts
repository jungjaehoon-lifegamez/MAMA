import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';

const MCP_MIGRATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'mcp-server',
  'src',
  'db',
  'migrations'
);

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function seedCase(
  db: Database.Database,
  caseId: string,
  overrides: Partial<{
    title: string;
    status: string;
    canonical_case_id: string | null;
    split_from_case_id: string | null;
  }> = {}
): void {
  db.prepare(
    `
      INSERT INTO case_truth (
        case_id, title, status, canonical_case_id, split_from_case_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z')
    `
  ).run(
    caseId,
    overrides.title ?? `Case ${caseId}`,
    overrides.status ?? 'active',
    overrides.canonical_case_id ?? null,
    overrides.split_from_case_id ?? null
  );
}

function insertLink(
  db: Database.Database,
  overrides: Partial<{
    link_id: string;
    case_id_from: string;
    case_id_to: string;
    link_type: string;
    source_kind: string;
    revoked_at: string | null;
    confidence: number | null;
  }> = {}
): void {
  db.prepare(
    `
      INSERT INTO case_links (
        link_id, case_id_from, case_id_to, link_type, created_at, created_by, confidence,
        reason_json, source_kind, source_ref, source_ref_fingerprint, revoked_at, revoked_by,
        revoke_reason
      )
      VALUES (?, ?, ?, ?, '2026-04-18T00:00:00.000Z', 'actor:test', ?, '{}', ?, NULL, NULL,
              ?, NULL, NULL)
    `
  ).run(
    overrides.link_id ?? `link-${Math.random().toString(16).slice(2)}`,
    overrides.case_id_from ?? 'case-a',
    overrides.case_id_to ?? 'case-b',
    overrides.link_type ?? 'related',
    overrides.confidence ?? null,
    overrides.source_kind ?? 'manual',
    overrides.revoked_at ?? null
  );
}

function insertTombstone(
  db: Database.Database,
  overrides: Partial<{
    tombstone_id: string;
    case_id_from: string;
    case_id_to: string;
    link_type: string;
    source_ref_fingerprint: Buffer;
    unsuppressed_at: string | null;
  }> = {}
): void {
  db.prepare(
    `
      INSERT INTO case_links_revoked_wiki_tombstones (
        tombstone_id, case_id_from, case_id_to, link_type, source_ref_fingerprint,
        source_ref, created_at, created_by, revoke_reason, unsuppressed_at, unsuppressed_by
      )
      VALUES (?, ?, ?, ?, ?, 'wiki://case-a', '2026-04-18T00:00:00.000Z', 'actor:test',
              'user revoked wiki link', ?, NULL)
    `
  ).run(
    overrides.tombstone_id ?? `tomb-${Math.random().toString(16).slice(2)}`,
    overrides.case_id_from ?? 'case-a',
    overrides.case_id_to ?? 'case-b',
    overrides.link_type ?? 'related',
    overrides.source_ref_fingerprint ?? sha256('case-a:case-b:related'),
    overrides.unsuppressed_at ?? null
  );
}

describe('case-first substrate — case_links schema', () => {
  it('accepts every first-class link type', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db, 'case-a');

    for (const [index, type] of [
      'related',
      'supersedes-case',
      'subcase-of',
      'blocked-by',
      'duplicate-of',
    ].entries()) {
      const targetId = `case-target-${index}`;
      seedCase(db, targetId);
      expect(() =>
        insertLink(db, {
          link_id: `link-${type}`,
          case_id_from: 'case-a',
          case_id_to: targetId,
          link_type: type,
        })
      ).not.toThrow();
    }

    db.close();
  });

  it('rejects self-links', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db, 'case-a');

    expect(() =>
      insertLink(db, {
        link_id: 'self-link',
        case_id_from: 'case-a',
        case_id_to: 'case-a',
      })
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

  it('enforces active uniqueness but permits revoked historical duplicates', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    seedCase(db, 'case-a');
    seedCase(db, 'case-b');

    insertLink(db, { link_id: 'link-active-1' });
    expect(() => insertLink(db, { link_id: 'link-active-2' })).toThrow(/UNIQUE constraint/i);

    db.prepare('UPDATE case_links SET revoked_at = ? WHERE link_id = ?').run(
      '2026-04-18T01:00:00.000Z',
      'link-active-1'
    );
    expect(() => insertLink(db, { link_id: 'link-active-3' })).not.toThrow();

    db.close();
  });

  it('creates the wiki tombstone table and enforces active tombstone uniqueness', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='case_links_revoked_wiki_tombstones'"
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('case_links_revoked_wiki_tombstones');

    const fingerprint = sha256('wiki-link');
    insertTombstone(db, {
      tombstone_id: 'tomb-active-1',
      source_ref_fingerprint: fingerprint,
    });

    expect(() =>
      insertTombstone(db, {
        tombstone_id: 'tomb-active-2',
        source_ref_fingerprint: fingerprint,
      })
    ).toThrow(/UNIQUE constraint/i);

    db.close();
  });

  it('allows a new active tombstone after the previous tombstone is unsuppressed', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const fingerprint = sha256('wiki-link-unsuppressed');
    insertTombstone(db, {
      tombstone_id: 'tomb-old',
      source_ref_fingerprint: fingerprint,
    });
    db.prepare(
      `UPDATE case_links_revoked_wiki_tombstones
       SET unsuppressed_at = ?, unsuppressed_by = ?
       WHERE tombstone_id = ?`
    ).run('2026-04-18T02:00:00.000Z', 'actor:test', 'tomb-old');

    expect(() =>
      insertTombstone(db, {
        tombstone_id: 'tomb-new',
        source_ref_fingerprint: fingerprint,
      })
    ).not.toThrow();

    db.close();
  });

  // Runtime case_links backfill behavior for canonical_case_id and
  // split_from_case_id is covered by case-links-store.test.ts.

  it('does not add Phase 3 migrations to the legacy MCP migration directory', () => {
    if (!existsSync(MCP_MIGRATIONS_DIR)) {
      return;
    }

    const mcpMigrations = readdirSync(MCP_MIGRATIONS_DIR);
    expect(mcpMigrations.some((file) => /^047-/.test(file))).toBe(false);
    expect(mcpMigrations.some((file) => /^04[5-9]-/.test(file))).toBe(false);
  });
});
