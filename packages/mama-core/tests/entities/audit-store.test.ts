import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';

describe('entity_audit_runs partial unique index', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-audit-store');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM entity_audit_findings').run();
    adapter.prepare('DELETE FROM entity_audit_metrics').run();
    adapter.prepare('DELETE FROM entity_audit_runs').run();
  });

  it('rejects a second concurrent running audit run via the partial unique index', () => {
    const adapter = getAdapter();
    adapter
      .prepare(`INSERT INTO entity_audit_runs (id, status, created_at) VALUES (?, 'running', ?)`)
      .run('run_first', Date.now());

    expect(() =>
      adapter
        .prepare(`INSERT INTO entity_audit_runs (id, status, created_at) VALUES (?, 'running', ?)`)
        .run('run_second', Date.now())
    ).toThrow();
  });

  it('allows multiple complete runs alongside a single running run', () => {
    const adapter = getAdapter();
    adapter
      .prepare(`INSERT INTO entity_audit_runs (id, status, created_at) VALUES (?, 'complete', ?)`)
      .run('run_done_a', Date.now());
    adapter
      .prepare(`INSERT INTO entity_audit_runs (id, status, created_at) VALUES (?, 'complete', ?)`)
      .run('run_done_b', Date.now());
    adapter
      .prepare(`INSERT INTO entity_audit_runs (id, status, created_at) VALUES (?, 'running', ?)`)
      .run('run_active', Date.now());

    const rows = adapter
      .prepare(
        `SELECT id FROM entity_audit_runs WHERE status IN ('running', 'complete') ORDER BY id`
      )
      .all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['run_active', 'run_done_a', 'run_done_b']);
  });
});
