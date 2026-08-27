import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type {
  DatabaseAdapter as DBManagerAdapter,
  PreparedStatement,
} from '../../src/db-manager.js';
import {
  createPrincipalRepository,
  PrincipalScopeGrantError,
  type PrincipalScopeGrantRef,
} from '../../src/identity/principal-repository.js';
import { applyMigrationsThrough } from '../../src/test-utils.js';

describe('Phase 2b principal scope grants over migration 065', () => {
  let adapter: DBManagerAdapter;
  let dbPath: string;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-principal-scope-grants-'));
    dbPath = join(tempDir, 'core.db');
    const migrationDb = new Database(dbPath);
    migrationDb.pragma('foreign_keys = ON');
    applyMigrationsThrough(migrationDb, 65);
    migrationDb.close();

    adapter = new NodeSQLiteAdapter({ dbPath }) as unknown as DBManagerAdapter;
    adapter.connect();
  });

  beforeEach(() => {
    adapter.prepare('DELETE FROM principal_scope_grants').run();
    adapter.prepare('DELETE FROM external_identities').run();
    adapter.prepare('DELETE FROM principals').run();
  });

  afterAll(() => {
    adapter.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createOwnerAndMember(): {
    ownerPrincipalId: string;
    memberPrincipalId: string;
  } {
    const repository = createPrincipalRepository(adapter);
    repository.ensureOwner({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'owner-external',
      now: 1,
    });
    const owner = repository.resolveByExternal('telegram', 'private', 'owner-external');
    const memberPrincipalId = repository.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'member-external',
      now: 2,
    });
    return { ownerPrincipalId: owner!.principalId, memberPrincipalId };
  }

  function beforeMatchingWrite(
    realAdapter: DBManagerAdapter,
    sqlFragment: string,
    beforeWrite: () => void
  ): Pick<DBManagerAdapter, 'prepare' | 'transaction'> {
    let invoked = false;
    return {
      prepare(sql: string): PreparedStatement {
        const statement = realAdapter.prepare(sql);
        if (!sql.includes(sqlFragment)) {
          return statement;
        }
        return {
          all: (...args: unknown[]) => statement.all(...args),
          get: (...args: unknown[]) => statement.get(...args),
          run: (...args: unknown[]) => {
            if (!invoked) {
              invoked = true;
              beforeWrite();
            }
            return statement.run(...args);
          },
        };
      },
      transaction: <T>(fn: () => T): T => realAdapter.transaction(fn),
    };
  }

  it('grants one canonical source idempotently through an active owner', () => {
    const repository = createPrincipalRepository(adapter);
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
    const input = {
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope: { kind: 'source' as const, connector: ' Telegram ', channelId: ' channel-1 ' },
      now: 10,
    };

    expect(repository.grantScope(input)).toBe('created');
    expect(repository.grantScope({ ...input, now: 11 })).toBe('exists');
    expect(repository.listActiveGrants(memberPrincipalId)).toEqual([
      {
        targetPrincipalId: memberPrincipalId,
        scope: { kind: 'source', connector: 'telegram', channelId: 'channel-1' },
        grantedByPrincipalId: ownerPrincipalId,
        createdAt: 10,
      },
    ]);
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM principal_scope_grants').get()).toEqual({
      count: 1,
    });
  });

  it('revokes idempotently, retains history, and permits a later re-grant', () => {
    const repository = createPrincipalRepository(adapter);
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
    const scope = {
      kind: 'memory' as const,
      scopeKind: 'project' as const,
      scopeId: ' project-1 ',
    };
    repository.grantScope({
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope,
      now: 20,
    });

    expect(
      repository.revokeScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId,
        scope,
        now: 21,
      })
    ).toBe('revoked');
    expect(
      repository.revokeScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId,
        scope,
        now: 22,
      })
    ).toBe('absent');
    expect(repository.listActiveGrants(memberPrincipalId)).toEqual([]);

    expect(
      repository.grantScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId,
        scope,
        now: 23,
      })
    ).toBe('created');
    expect(
      adapter
        .prepare(
          `SELECT created_at, revoked_at
           FROM principal_scope_grants
           ORDER BY created_at ASC`
        )
        .all()
    ).toEqual([
      { created_at: 20, revoked_at: 21 },
      { created_at: 23, revoked_at: null },
    ]);
  });

  it('returns exists when two SQLite connections grant the same scope concurrently', () => {
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
    const input = {
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope: { kind: 'source' as const, connector: 'telegram', channelId: 'shared-race' },
      now: 24,
    };
    const secondAdapter = new NodeSQLiteAdapter({ dbPath }) as unknown as DBManagerAdapter;
    secondAdapter.connect();
    try {
      const secondRepository = createPrincipalRepository(secondAdapter);
      let secondResult: 'created' | 'exists' | undefined;
      const firstRepository = createPrincipalRepository(
        beforeMatchingWrite(adapter, 'INSERT INTO principal_scope_grants', () => {
          secondResult = secondRepository.grantScope({ ...input, now: 25 });
        })
      );

      expect(firstRepository.grantScope(input)).toBe('exists');
      expect(secondResult).toBe('created');
      expect(
        adapter
          .prepare(
            `SELECT COUNT(*) AS count
             FROM principal_scope_grants
             WHERE principal_id = ? AND revoked_at IS NULL`
          )
          .get(memberPrincipalId)
      ).toEqual({ count: 1 });
    } finally {
      secondAdapter.disconnect();
    }
  });

  it('returns absent when two SQLite connections revoke the same scope concurrently', () => {
    const repository = createPrincipalRepository(adapter);
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
    const input = {
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope: { kind: 'memory' as const, scopeKind: 'project' as const, scopeId: 'race-project' },
      now: 26,
    };
    repository.grantScope(input);
    const secondAdapter = new NodeSQLiteAdapter({ dbPath }) as unknown as DBManagerAdapter;
    secondAdapter.connect();
    try {
      const secondRepository = createPrincipalRepository(secondAdapter);
      let secondResult: 'revoked' | 'absent' | undefined;
      const firstRepository = createPrincipalRepository(
        beforeMatchingWrite(adapter, 'UPDATE principal_scope_grants', () => {
          secondResult = secondRepository.revokeScope({ ...input, now: 28 });
        })
      );

      expect(firstRepository.revokeScope({ ...input, now: 27 })).toBe('absent');
      expect(secondResult).toBe('revoked');
      expect(repository.listActiveGrants(memberPrincipalId)).toEqual([]);
      expect(adapter.prepare('SELECT COUNT(*) AS count FROM principal_scope_grants').get()).toEqual(
        { count: 1 }
      );
    } finally {
      secondAdapter.disconnect();
    }
  });

  it('lists a fresh detached snapshot instead of reusing prior results', () => {
    const repository = createPrincipalRepository(adapter);
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
    const sourceScope = { kind: 'source' as const, connector: 'slack', channelId: 'C1' };
    repository.grantScope({
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope: sourceScope,
      now: 30,
    });

    const first = repository.listActiveGrants(memberPrincipalId);
    (first[0].scope as { kind: 'source'; connector: string; channelId: string }).channelId =
      'tampered';
    repository.grantScope({
      targetPrincipalId: memberPrincipalId,
      ownerPrincipalId,
      scope: { kind: 'memory', scopeKind: 'channel', scopeId: 'shared-channel' },
      now: 31,
    });

    expect(repository.listActiveGrants(memberPrincipalId)).toEqual([
      {
        targetPrincipalId: memberPrincipalId,
        scope: { kind: 'source', connector: 'slack', channelId: 'C1' },
        grantedByPrincipalId: ownerPrincipalId,
        createdAt: 30,
      },
      {
        targetPrincipalId: memberPrincipalId,
        scope: { kind: 'memory', scopeKind: 'channel', scopeId: 'shared-channel' },
        grantedByPrincipalId: ownerPrincipalId,
        createdAt: 31,
      },
    ]);
  });

  it.each(['suspended', 'offboarded'] as const)(
    'makes grants ineffective when the member is %s without deleting history',
    (status) => {
      const repository = createPrincipalRepository(adapter);
      const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
      repository.grantScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId,
        scope: { kind: 'source', connector: 'discord', channelId: 'shared-1' },
        now: 40,
      });

      repository[status === 'suspended' ? 'suspend' : 'offboard'](memberPrincipalId, 41);

      expect(repository.listActiveGrants(memberPrincipalId)).toEqual([]);
      expect(adapter.prepare('SELECT COUNT(*) AS count FROM principal_scope_grants').get()).toEqual(
        { count: 1 }
      );
    }
  );

  it('rejects grant and revoke mutations when the target is not an active member', () => {
    const repository = createPrincipalRepository(adapter);
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
    repository.suspend(memberPrincipalId, 50);
    const scope = { kind: 'source' as const, connector: 'telegram', channelId: 'shared-2' };

    expect(() =>
      repository.grantScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId,
        scope,
        now: 51,
      })
    ).toThrowError(expect.objectContaining({ code: 'target_not_active_member' }));
    expect(() =>
      repository.revokeScope({
        targetPrincipalId: ownerPrincipalId,
        ownerPrincipalId,
        scope,
        now: 52,
      })
    ).toThrow(PrincipalScopeGrantError);
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM principal_scope_grants').get()).toEqual({
      count: 0,
    });
  });

  it('rejects mutation authority from a member or inactive owner', () => {
    const repository = createPrincipalRepository(adapter);
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();
    const scope = { kind: 'memory' as const, scopeKind: 'global' as const, scopeId: 'team' };

    expect(() =>
      repository.grantScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId: memberPrincipalId,
        scope,
        now: 60,
      })
    ).toThrowError(expect.objectContaining({ code: 'grantor_not_active_owner' }));

    adapter
      .prepare("UPDATE principals SET status = 'suspended' WHERE principal_id = ?")
      .run(ownerPrincipalId);
    expect(() =>
      repository.revokeScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId,
        scope,
        now: 61,
      })
    ).toThrowError(expect.objectContaining({ code: 'grantor_not_active_owner' }));
  });

  it.each([
    { kind: 'source', connector: '', channelId: 'channel-1' },
    { kind: 'source', connector: 'telegram', channelId: '   ' },
    { kind: 'source', connector: 'telegram', channelId: '*' },
    { kind: 'memory', scopeKind: 'user', scopeId: 'another-member' },
    { kind: 'memory', scopeKind: 'project', scopeId: '' },
    { kind: 'role', scopeKind: 'project', scopeId: 'project-1' },
  ])('fails closed for malformed or unsupported grant scope %#', (scope) => {
    const repository = createPrincipalRepository(adapter);
    const { ownerPrincipalId, memberPrincipalId } = createOwnerAndMember();

    expect(() =>
      repository.grantScope({
        targetPrincipalId: memberPrincipalId,
        ownerPrincipalId,
        scope: scope as unknown as PrincipalScopeGrantRef,
        now: 70,
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_scope' }));
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM principal_scope_grants').get()).toEqual({
      count: 0,
    });
  });
});
