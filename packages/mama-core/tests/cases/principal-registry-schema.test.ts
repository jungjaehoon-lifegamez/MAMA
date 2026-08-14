import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

describe('TG-01/TG-04 principal registry schema (migration 064)', () => {
  it('applies migration 064 above the version-63 tip and creates both tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    applyMigrationsThrough(db, 63);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toMatchObject({
      version: 63,
    });
    expect(tableExists(db, 'principals')).toBe(false);
    expect(tableExists(db, 'external_identities')).toBe(false);

    applyMigrationsThrough(db, 64, 64);

    expect(tableExists(db, 'principals')).toBe(true);
    expect(tableExists(db, 'external_identities')).toBe(true);
    expect(
      db.prepare('SELECT version, description FROM schema_version WHERE version = 64').get()
    ).toEqual({
      version: 64,
      description: 'Create principals and external_identities for member registry',
    });

    db.close();
  });

  it('allows at most one active owner while allowing a suspended owner', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 64);

    const insertPrincipal = db.prepare(
      `INSERT INTO principals (
        principal_id, kind, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertPrincipal.run('principal-owner-active', 'owner', 'Active owner', 'active', 1, 1);

    expect(() =>
      insertPrincipal.run('principal-owner-second', 'owner', 'Second owner', 'active', 2, 2)
    ).toThrow(/UNIQUE constraint/i);

    expect(() =>
      insertPrincipal.run(
        'principal-owner-suspended',
        'owner',
        'Suspended owner',
        'suspended',
        3,
        3
      )
    ).not.toThrow();

    db.close();
  });

  it('stores the same external ID independently by connector and namespace', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 64);

    db.prepare(
      `INSERT INTO principals (
        principal_id, kind, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('principal-member', 'member', 'Member', 'active', 1, 1);

    const insertIdentity = db.prepare(
      `INSERT INTO external_identities (
        connector, namespace, external_id, principal_id, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    insertIdentity.run('telegram', 'global', '123', 'principal-member', 2);
    insertIdentity.run('slack', 'T1', '123', 'principal-member', 3);
    insertIdentity.run('discord', 'G1', '123', 'principal-member', 4);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM external_identities WHERE external_id = '123'").get()
    ).toEqual({ count: 3 });

    db.close();
  });

  it('declares the principal_id foreign key on external identities', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 64);

    const foreignKeys = db.prepare('PRAGMA foreign_key_list(external_identities)').all() as Array<{
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
      ])
    );

    db.close();
  });
});
