import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseInstance } from '../../src/db-manager.js';
import { createPrincipalRepository } from '../../src/identity/principal-repository.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import { applyMigrationsThrough } from '../helpers/test-utils.js';

describe('migration 105 principal lifecycle transitions', () => {
  it('tracks status transitions independently of timestamps, names and other people', () => {
    const root = mkdtempSync(join(tmpdir(), 'principal-transitions-'));
    const path = join(root, 'state.db');
    const db = new Database(path);
    const adapter = new NodeSQLiteAdapter({ dbPath: path });
    try {
      db.pragma('foreign_keys = ON');
      applyMigrationsThrough(db, 105);
      db.close();
      adapter.connect();
      const repo = createPrincipalRepository(adapter as unknown as DatabaseInstance);
      const register = (id: string) =>
        repo.registerMember({ connector: 'fixture', namespace: 'private', externalId: id, now: 1 });
      const member = register('fixture-person');
      const other = register('fixture-other');
      expect(repo.lifecycleVersion(member)).toBe(0);
      repo.setDisplayName({ principalId: member, displayName: 'Fixture member', now: 10 });
      expect(repo.lifecycleVersion(member)).toBe(0);
      repo.suspend(other, 10);
      expect(repo.lifecycleVersion(member)).toBe(0);
      repo.suspend(member, 10);
      const suspended = repo.lifecycleVersion(member);
      repo.resume(member, 10);
      expect(repo.lifecycleVersion(member)).toBeGreaterThan(suspended);
      expect(
        adapter
          .prepare(
            'SELECT from_status, to_status, occurred_at FROM principal_lifecycle_transitions WHERE principal_id=? ORDER BY transition_id'
          )
          .all(member)
      ).toEqual([
        { from_status: 'active', to_status: 'suspended', occurred_at: 10 },
        { from_status: 'suspended', to_status: 'active', occurred_at: 10 },
      ]);
      const resumed = repo.lifecycleVersion(member);
      expect(() =>
        adapter.transaction(() => {
          repo.suspend(member, 10);
          throw new Error('fixture rollback');
        })
      ).toThrow('fixture rollback');
      expect(repo.lifecycleVersion(member)).toBe(resumed);
    } finally {
      if (db.open) db.close();
      adapter.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
