import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipalRepository } from '../../src/identity/principal-repository.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import { applyMigrationsThrough } from '../helpers/test-utils.js';

describe('consumer-defined member roles and identity-free common principal', () => {
  let db: Database.Database;
  let adapter: DatabaseAdapter;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 104);
    adapter = {
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn)(),
    } as DatabaseAdapter;
  });
  afterEach(() => db.close());

  function member(externalId = 'member-1') {
    return createPrincipalRepository(adapter).registerMember({
      connector: 'test',
      namespace: 'test',
      externalId,
      now: 1,
    });
  }

  it('creates an active owner with no external identity, retaining named conflicts', () => {
    const repository = createPrincipalRepository(adapter);
    expect(repository.ensureOwner({ principalId: 'common', now: 2 })).toBe('created');
    expect(repository.ensureOwner({ principalId: 'common' })).toBe('exists');
    expect(repository.findById('common')).toEqual({
      principalId: 'common',
      kind: 'owner',
      status: 'active',
    });
    expect(db.prepare('SELECT * FROM external_identities').all()).toEqual([]);
    expect(repository.ensureOwner({ principalId: 'another-common' })).toBe('conflict');
    expect(repository.ensureOwner({ principalId: member() })).toBe('conflict');
    expect(() => repository.ensureOwner({ principalId: '  ' })).toThrow(/nonblank/);
  });

  it('still binds an identity to a named common principal and retains identity conflicts', () => {
    const repository = createPrincipalRepository(adapter);
    repository.ensureOwner({ principalId: 'common', now: 2 });
    const identity = { connector: 'test', namespace: 'test', externalId: 'common-external' };
    expect(repository.ensureOwner({ principalId: 'common', ...identity })).toBe('exists');
    expect(repository.resolveByExternal('test', 'test', 'common-external')?.principalId).toBe(
      'common'
    );
    expect(repository.ensureOwner({ ...identity })).toBe('exists');
    expect(repository.ensureOwner({ principalId: 'elsewhere', ...identity })).toBe('conflict');
    expect(() =>
      repository.ensureOwner({ principalId: 'common', connector: 'test' } as never)
    ).toThrow(/identity/);
  });

  it('grants arbitrary roles idempotently and exposes active members only', () => {
    const repository = createPrincipalRepository(adapter);
    const first = member();
    const second = member('member-2');
    expect(repository.grantRole({ principalId: first, role: 'reviewer', now: 10 })).toBe('created');
    expect(repository.grantRole({ principalId: first, role: 'reviewer', now: 11 })).toBe('exists');
    repository.grantRole({ principalId: first, role: 'coordinator', now: 12 });
    repository.grantRole({ principalId: second, role: 'reviewer' });
    expect(repository.listRoles(first)).toEqual([
      { principalId: first, role: 'reviewer', createdAt: 10 },
      { principalId: first, role: 'coordinator', createdAt: 12 },
    ]);
    expect(repository.listActiveMembersWithRole('reviewer').map((p) => p.principalId)).toEqual(
      [first, second].sort()
    );
    repository.suspend(first, 20);
    expect(repository.listRoles(first)).toHaveLength(2);
    expect(repository.listActiveMembersWithRole('reviewer').map((p) => p.principalId)).toEqual([
      second,
    ]);
    repository.resume(first, 21);
    expect(repository.listActiveMembersWithRole('reviewer')).toHaveLength(2);
    repository.offboard(first, 22);
    expect(repository.listActiveMembersWithRole('reviewer')).toHaveLength(1);
    expect(repository.listRoles('unknown')).toEqual([]);
  });

  it('rejects blank roles and grants to missing, owner, suspended or offboarded principals', () => {
    const repository = createPrincipalRepository(adapter);
    repository.ensureOwner({ principalId: 'common', now: 1 });
    const id = member();
    for (const role of ['', '  ', '\t\n'])
      expect(() => repository.grantRole({ principalId: id, role })).toThrow(/nonblank/);
    for (const principalId of ['unknown', 'common'])
      expect(() => repository.grantRole({ principalId, role: 'reviewer' })).toThrow(
        /active member/
      );
    repository.grantRole({ principalId: id, role: 'reviewer' });
    repository.suspend(id, 20);
    expect(() => repository.grantRole({ principalId: id, role: 'reviewer' })).toThrow(
      /active member/
    );
    repository.offboard(id, 21);
    expect(() => repository.grantRole({ principalId: id, role: 'reviewer' })).toThrow(
      /active member/
    );
  });

  it('enforces the role FK, nonblank role, unique pair in migration 104', () => {
    const repository = createPrincipalRepository(adapter);
    repository.ensureOwner({ principalId: 'common', now: 1 });
    const id = member();
    const insert = db.prepare(
      'INSERT INTO principal_roles (principal_id, role, created_at) VALUES (?, ?, 2)'
    );
    insert.run(id, 'reviewer');
    expect(() => insert.run(id, 'reviewer')).toThrow(/UNIQUE/);
    expect(() => insert.run(id, ' ')).toThrow(/CHECK/);
    expect(() => insert.run('missing', 'reviewer')).toThrow();
    expect(db.prepare('PRAGMA foreign_key_list(principal_roles)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'principals', from: 'principal_id', to: 'principal_id' }),
      ])
    );
    expect(db.prepare('SELECT version FROM schema_version WHERE version=104').get()).toEqual({
      version: 104,
    });
  });
});
