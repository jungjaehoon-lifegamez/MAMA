import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import { createPrincipalRepository } from '../../src/identity/principal-repository.js';
import { applyMigrationsThrough } from '../helpers/test-utils.js';

describe('caller-named owner registration', () => {
  let home: string;
  let adapter: NodeSQLiteAdapter;
  const input = {
    principalId: 'fixture-owner',
    connector: 'telegram',
    namespace: 'private',
    externalId: '1001',
    now: 100,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'named-owner-'));
    const dbPath = join(home, 'core.db');
    vi.stubEnv('HOME', home);
    vi.stubEnv('MAMA_DB_PATH', dbPath);
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 65);
    db.close();
    adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
  });

  afterEach(() => {
    adapter.disconnect();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function snapshot() {
    return {
      principals: adapter.prepare('SELECT * FROM principals ORDER BY principal_id').all(),
      identities: adapter
        .prepare('SELECT * FROM external_identities ORDER BY connector, namespace, external_id')
        .all(),
    };
  }

  function seedPrincipal(kind: 'owner' | 'member', status = 'active') {
    adapter
      .prepare(
        `INSERT INTO principals (principal_id, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(input.principalId, kind, status);
  }

  it('creates the supplied id and repeats without changing rows', () => {
    const repository = createPrincipalRepository(adapter);
    expect(repository.ensureOwner(input)).toBe('created');
    expect(repository.resolveByExternal('telegram', 'private', '1001')).toEqual({
      principalId: 'fixture-owner',
      kind: 'owner',
      status: 'active',
    });
    const before = snapshot();
    expect(before.principals).toHaveLength(1);
    expect(before.identities).toHaveLength(1);
    expect(repository.ensureOwner({ ...input, now: 101 })).toBe('exists');
    expect(snapshot()).toEqual(before);
  });

  it('binds an unbound identity to the existing active named owner', () => {
    seedPrincipal('owner');
    const repository = createPrincipalRepository(adapter);
    const principals = snapshot().principals;
    expect(repository.ensureOwner(input)).toBe('exists');
    expect(snapshot().principals).toEqual(principals);
    expect(repository.resolveByExternal('telegram', 'private', '1001')?.principalId).toBe(
      'fixture-owner'
    );
    expect(repository.ensureOwner({ ...input, externalId: '1002' })).toBe('exists');
    expect(snapshot().identities).toHaveLength(2);
  });

  it.each(['owner', 'member'] as const)(
    'conflicts when the identity is bound to another %s',
    (kind) => {
      const repository = createPrincipalRepository(adapter);
      const identity = { connector: 'telegram', namespace: 'private', externalId: '1001', now: 1 };
      if (kind === 'owner') repository.ensureOwner(identity);
      else repository.registerMember(identity);
      const before = snapshot();
      expect(repository.ensureOwner(input)).toBe('conflict');
      expect(snapshot()).toEqual(before);
    }
  );

  it('conflicts when a different active owner exists and the identity is unbound', () => {
    const repository = createPrincipalRepository(adapter);
    repository.ensureOwner({ ...input, principalId: 'fixture-other', externalId: '1002' });
    const before = snapshot();
    expect(repository.ensureOwner(input)).toBe('conflict');
    expect(repository.resolveByExternal('telegram', 'private', '1001')).toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['member', 'active'],
    ['owner', 'suspended'],
    ['owner', 'offboarded'],
  ] as const)('conflicts when the named principal is %s/%s', (kind, status) => {
    seedPrincipal(kind, status);
    const repository = createPrincipalRepository(adapter);
    const before = snapshot();
    expect(repository.ensureOwner(input)).toBe('conflict');
    expect(snapshot()).toEqual(before);
    repository.bindIdentity(input.principalId, 'telegram', 'private', '1001', 1);
    const bound = snapshot();
    expect(repository.ensureOwner(input)).toBe('conflict');
    expect(snapshot()).toEqual(bound);
  });

  it.each(['', '   '])('rejects a blank named id %# without writing', (principalId) => {
    const repository = createPrincipalRepository(adapter);
    expect(() => repository.ensureOwner({ ...input, principalId })).toThrow(/principalId/);
    expect(snapshot()).toEqual({ principals: [], identities: [] });
  });

  it('rolls back the named principal if binding the identity fails', () => {
    adapter.exec(`CREATE TRIGGER reject_fixture_identity BEFORE INSERT ON external_identities
      BEGIN SELECT RAISE(ABORT, 'fixture binding failure'); END`);
    expect(() => createPrincipalRepository(adapter).ensureOwner(input)).toThrow(
      'fixture binding failure'
    );
    expect(snapshot()).toEqual({ principals: [], identities: [] });
  });

  it('lets the registered named owner grant a scope to an active member', () => {
    const repository = createPrincipalRepository(adapter);
    expect(repository.ensureOwner(input)).toBe('created');
    const memberId = repository.registerMember({ ...input, externalId: '1002' });
    expect(
      repository.grantScope({
        targetPrincipalId: memberId,
        ownerPrincipalId: 'fixture-owner',
        scope: { kind: 'memory', scopeKind: 'global', scopeId: 'fixture-shared' },
        now: 101,
      })
    ).toBe('created');
    expect(repository.listActiveGrants(memberId)).toMatchObject([
      { grantedByPrincipalId: 'fixture-owner', targetPrincipalId: memberId },
    ]);
  });
});
