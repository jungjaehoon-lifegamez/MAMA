import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function insertPrincipal(
  db: Database.Database,
  principalId: string,
  kind: 'owner' | 'member'
): void {
  db.prepare(
    `INSERT INTO principals (
      principal_id, kind, display_name, status, created_at, updated_at
    ) VALUES (?, ?, NULL, 'active', 1, 1)`
  ).run(principalId, kind);
}

describe('Phase 2b principal scope grant schema (migration 065)', () => {
  it('adds the grant authority immediately above migration 064', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    applyMigrationsThrough(db, 64);
    expect(tableExists(db, 'principal_scope_grants')).toBe(false);

    applyMigrationsThrough(db, 65, 65);

    expect(tableExists(db, 'principal_scope_grants')).toBe(true);
    expect(
      db.prepare('SELECT version, description FROM schema_version WHERE version = 65').get()
    ).toEqual({
      version: 65,
      description: 'Create principal scope grants for human-team access',
    });

    db.close();
  });

  it('allows only closed source or shared-memory grant kinds', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 65);
    insertPrincipal(db, 'principal-owner', 'owner');
    insertPrincipal(db, 'principal-member', 'member');

    const insertGrant = db.prepare(
      `INSERT INTO principal_scope_grants (
        principal_id, grant_kind, scope_kind, scope_id,
        granted_by_principal_id, created_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)`
    );

    expect(() =>
      insertGrant.run('principal-member', 'policy', 'allow', '*', 'principal-owner', 2)
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      insertGrant.run('principal-member', 'memory', 'user', 'another-member', 'principal-owner', 2)
    ).toThrow(/CHECK constraint/i);

    db.close();
  });

  it('permits only one active logical grant while retaining revoked history', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 65);
    insertPrincipal(db, 'principal-owner', 'owner');
    insertPrincipal(db, 'principal-member', 'member');

    const insertGrant = db.prepare(
      `INSERT INTO principal_scope_grants (
        principal_id, grant_kind, scope_kind, scope_id,
        granted_by_principal_id, created_at, revoked_at
      ) VALUES ('principal-member', 'source', 'telegram', 'channel-1',
        'principal-owner', ?, NULL)`
    );
    insertGrant.run(2);

    expect(() => insertGrant.run(3)).toThrow(/UNIQUE constraint/i);

    db.prepare(
      `UPDATE principal_scope_grants
       SET revoked_at = 4
       WHERE principal_id = 'principal-member' AND revoked_at IS NULL`
    ).run();
    expect(() => insertGrant.run(5)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM principal_scope_grants').get()).toEqual({
      count: 2,
    });

    db.close();
  });

  it('references both the target principal and granting principal', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 65);

    const foreignKeys = db
      .prepare('PRAGMA foreign_key_list(principal_scope_grants)')
      .all() as Array<{
      table: string;
      from: string;
      to: string;
    }>;

    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'principals',
          from: 'principal_id',
          to: 'principal_id',
        }),
        expect.objectContaining({
          table: 'principals',
          from: 'granted_by_principal_id',
          to: 'principal_id',
        }),
      ])
    );

    db.close();
  });
});
