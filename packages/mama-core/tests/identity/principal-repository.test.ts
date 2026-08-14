import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter as DBManagerAdapter } from '../../src/db-manager.js';
import { createPrincipalRepository } from '../../src/identity/principal-repository.js';
import { applyMigrationsThrough } from '../../src/test-utils.js';

describe('TG-01/TG-04 principal repository over migration 064', () => {
  let adapter: DBManagerAdapter;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-principal-repository-'));
    const dbPath = join(tempDir, 'core.db');
    const migrationDb = new Database(dbPath);
    migrationDb.pragma('foreign_keys = ON');
    applyMigrationsThrough(migrationDb, 64);
    migrationDb.close();

    adapter = new NodeSQLiteAdapter({ dbPath }) as unknown as DBManagerAdapter;
    adapter.connect();
  });

  beforeEach(() => {
    adapter.prepare('DELETE FROM external_identities').run();
    adapter.prepare('DELETE FROM principals').run();
  });

  afterAll(() => {
    adapter.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a registered member and returns null for an unknown external identity', () => {
    const repository = createPrincipalRepository(adapter);
    const principalId = repository.registerMember({
      displayName: 'Primary member',
      connector: 'telegram',
      namespace: 'private',
      externalId: 'external-1',
      now: 100,
    });

    expect(repository.resolveByExternal('telegram', 'private', 'external-1')).toEqual({
      principalId,
      kind: 'member',
      status: 'active',
    });
    expect(repository.resolveByExternal('telegram', 'private', 'missing')).toBeNull();
  });

  it('changes a member status to suspended', () => {
    const repository = createPrincipalRepository(adapter);
    const principalId = repository.registerMember({
      connector: 'slack',
      namespace: 'workspace-1',
      externalId: 'external-2',
      now: 200,
    });

    repository.suspend(principalId, 201);

    expect(repository.resolveByExternal('slack', 'workspace-1', 'external-2')).toEqual({
      principalId,
      kind: 'member',
      status: 'suspended',
    });
  });

  it('rejects suspending or offboarding the owner', () => {
    const repository = createPrincipalRepository(adapter);
    expect(
      repository.ensureOwner({
        connector: 'telegram',
        namespace: 'private',
        externalId: 'owner-external',
        now: 300,
      })
    ).toBe('created');
    const owner = repository.resolveByExternal('telegram', 'private', 'owner-external');

    expect(() => repository.suspend(owner!.principalId, 301)).toThrow(/owner/i);
    expect(() => repository.offboard(owner!.principalId, 302)).toThrow(/owner/i);
    expect(repository.resolveByExternal('telegram', 'private', 'owner-external')).toMatchObject({
      kind: 'owner',
      status: 'active',
    });
  });

  it('ensures the same owner binding idempotently', () => {
    const repository = createPrincipalRepository(adapter);
    const input = {
      connector: 'telegram',
      namespace: 'private',
      externalId: 'owner-external',
      now: 400,
    };

    expect(repository.ensureOwner(input)).toBe('created');
    expect(repository.ensureOwner({ ...input, now: 401 })).toBe('exists');
    expect(
      adapter.prepare("SELECT COUNT(*) AS count FROM principals WHERE kind = 'owner'").get()
    ).toEqual({ count: 1 });
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM external_identities').get()).toEqual({
      count: 1,
    });
  });

  it('returns conflict for a distinct second owner and creates nothing', () => {
    const repository = createPrincipalRepository(adapter);
    expect(
      repository.ensureOwner({
        connector: 'telegram',
        namespace: 'private',
        externalId: 'owner-external-1',
        now: 500,
      })
    ).toBe('created');

    expect(
      repository.ensureOwner({
        connector: 'slack',
        namespace: 'workspace-1',
        externalId: 'owner-external-2',
        now: 501,
      })
    ).toBe('conflict');
    expect(repository.resolveByExternal('slack', 'workspace-1', 'owner-external-2')).toBeNull();
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM principals').get()).toEqual({ count: 1 });
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM external_identities').get()).toEqual({
      count: 1,
    });
  });

  it('returns conflict when the owner identity is already bound to a member', () => {
    const repository = createPrincipalRepository(adapter);
    const memberId = repository.registerMember({
      connector: 'discord',
      namespace: 'guild-1',
      externalId: 'shared-external',
      now: 600,
    });

    expect(
      repository.ensureOwner({
        connector: 'discord',
        namespace: 'guild-1',
        externalId: 'shared-external',
        now: 601,
      })
    ).toBe('conflict');
    expect(repository.resolveByExternal('discord', 'guild-1', 'shared-external')).toMatchObject({
      principalId: memberId,
      kind: 'member',
    });
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM principals').get()).toEqual({ count: 1 });
  });

  it('isolates the same numeric external ID across connectors', () => {
    const repository = createPrincipalRepository(adapter);
    const principalIds = ['telegram', 'slack', 'discord'].map((connector, index) =>
      repository.registerMember({
        connector,
        namespace: 'shared',
        externalId: '12345',
        now: 700 + index,
      })
    );

    expect(new Set(principalIds).size).toBe(3);
    expect(
      ['telegram', 'slack', 'discord'].map(
        (connector) => repository.resolveByExternal(connector, 'shared', '12345')?.principalId
      )
    ).toEqual(principalIds);
  });

  it('binds another external identity to an existing principal', () => {
    const repository = createPrincipalRepository(adapter);
    const principalId = repository.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'external-primary',
      now: 800,
    });

    repository.bindIdentity(principalId, 'slack', 'workspace-1', 'external-secondary', 801);

    expect(repository.resolveByExternal('slack', 'workspace-1', 'external-secondary')).toEqual({
      principalId,
      kind: 'member',
      status: 'active',
    });
  });

  it('lists members with display names and current statuses while excluding the owner', () => {
    const repository = createPrincipalRepository(adapter);
    const firstId = repository.registerMember({
      displayName: 'Primary member',
      connector: 'telegram',
      namespace: 'private',
      externalId: 'member-1',
      now: 900,
    });
    const secondId = repository.registerMember({
      connector: 'slack',
      namespace: 'workspace-1',
      externalId: 'member-2',
      now: 901,
    });
    repository.suspend(secondId, 902);
    repository.ensureOwner({
      connector: 'discord',
      namespace: 'guild-1',
      externalId: 'owner-external',
      now: 903,
    });

    expect(repository.listMembers()).toEqual([
      { principalId: firstId, displayName: 'Primary member', status: 'active' },
      { principalId: secondId, status: 'suspended' },
    ]);
  });
});
