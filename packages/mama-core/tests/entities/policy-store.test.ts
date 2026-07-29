import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

function clearPhase8Tables(): void {
  const adapter = getAdapter();
  const tables = adapter
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('entity_policy', 'entity_role_bindings', 'entity_policy_proposals', 'memory_events')
      `
    )
    .all() as Array<{ name: string }>;

  for (const table of tables.map((row) => row.name)) {
    adapter.prepare(`DELETE FROM ${table}`).run();
  }
}

describe('Story E1.24: Phase 8 policy substrate', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-policy-store');
  });

  beforeEach(() => {
    clearPhase8Tables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: migrations create the required Phase 8 tables', () => {
    it('should create the entity policy tables', () => {
      const adapter = getAdapter();
      const tables = adapter
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `
        )
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((row) => row.name);

      expect(tableNames).toContain('entity_policy');
      expect(tableNames).toContain('entity_role_bindings');
      expect(tableNames).toContain('entity_policy_proposals');
    });
  });
});
