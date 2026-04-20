
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';
describe('Phase 2 Task 1 — entity_timeline_events.role', () => {
  it('adds a nullable role column after applying 044', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const columns = db.prepare('PRAGMA table_info(entity_timeline_events)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;

    const roleColumn = columns.find((col) => col.name === 'role');
    expect(roleColumn).toBeDefined();
    expect(roleColumn?.type).toBe('TEXT');
    expect(roleColumn?.notnull).toBe(0);
    expect(roleColumn?.dflt_value).toBeNull();

    db.close();
  });

  it('role column is present after migration 030 (Phase 2 consolidated)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    const cols = db.prepare('PRAGMA table_info(entity_timeline_events)').all() as Array<{
      name: string;
    }>;
    expect(cols.some((col) => col.name === 'role')).toBe(true);

    db.close();
  });

  it('role column accepts all spec §5.1 values and NULL', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    db.prepare(
      `
        INSERT OR IGNORE INTO entity_nodes
          (id, kind, preferred_label, status, scope_kind, scope_id, created_at, updated_at)
        VALUES (?, 'project', 'Test', 'active', 'project', 'test-project', ?, ?)
      `
    ).run('entity_role_test', Date.now(), Date.now());

    const insert = db.prepare(
      `
        INSERT INTO entity_timeline_events
          (id, entity_id, event_type, valid_from, valid_to, observed_at, source_ref,
           summary, details, role, created_at)
        VALUES (?, ?, 'status_changed', NULL, NULL, ?, 'test', 'summary', 'details', ?, ?)
      `
    );

    for (const role of ['requester', 'implementer', 'reviewer', 'observer', 'affected', null]) {
      expect(() =>
        insert.run(`evt_${role ?? 'null'}`, 'entity_role_test', Date.now(), role, Date.now())
      ).not.toThrow();
    }

    const rows = db
      .prepare("SELECT role FROM entity_timeline_events WHERE id LIKE 'evt_%' ORDER BY id")
      .all() as Array<{ role: string | null }>;
    expect(rows).toHaveLength(6);

    db.close();
  });
});
