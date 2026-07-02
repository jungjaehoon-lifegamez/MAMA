import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function indexExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function tableSql(db: Database.Database, name: string): string {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name) as {
      sql: string;
    }
  ).sql;
}

describe('Story VNext PR0: operator contract migration', () => {
  it('AC: creates vNext operator ledger tables and records migration 038', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 38);

    expect(tableExists(db, 'vnext_operator_cursors')).toBe(true);
    expect(tableExists(db, 'vnext_operator_commits')).toBe(true);
    expect(tableExists(db, 'operator_no_updates')).toBe(true);
    expect(tableExists(db, 'worker_proposals')).toBe(true);

    expect(indexExists(db, 'idx_vnext_operator_commits_cursor_seq')).toBe(true);
    expect(indexExists(db, 'idx_operator_no_updates_scope_created')).toBe(true);
    expect(indexExists(db, 'idx_worker_proposals_status_kind')).toBe(true);

    const row = db
      .prepare('SELECT version, description FROM schema_version WHERE version = 38')
      .get() as { version: number; description: string } | undefined;
    expect(row?.version).toBe(38);
    expect(row?.description).toContain('vNext operator contracts');

    db.close();
  });

  it('AC: enforces operator commit sequence and cursor integrity', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 38);

    const commitSql = tableSql(db, 'vnext_operator_commits');
    expect(commitSql).toMatch(/first_change_seq\s+INTEGER\s+NOT\s+NULL\s+CHECK/i);
    expect(commitSql).toMatch(/last_change_seq\s+INTEGER\s+NOT\s+NULL\s+CHECK/i);
    expect(commitSql).toMatch(/FOREIGN KEY\s*\(\s*cursor_name\s*\)/i);

    db.prepare(
      `INSERT INTO vnext_operator_cursors (
        cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
      ) VALUES (?, ?, ?, ?)`
    ).run('connector:slack', 0, null, 1710000000000);

    db.prepare(
      `INSERT INTO vnext_operator_commits (
        commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
        status, changed_refs_json, source_refs_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'commit-1',
      'connector:slack',
      'connector:slack:seq:1-3',
      1,
      3,
      'changed',
      '["task:1"]',
      '["raw:slack:event-1"]',
      1710000000001
    );

    expect(() =>
      db
        .prepare(
          `INSERT INTO vnext_operator_commits (
            commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
            status, changed_refs_json, source_refs_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'commit-negative',
          'connector:slack',
          'connector:slack:seq:-1-0',
          -1,
          0,
          'changed',
          '[]',
          '["raw:slack:event-2"]',
          1710000000002
        )
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      db
        .prepare(
          `INSERT INTO vnext_operator_commits (
            commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
            status, changed_refs_json, source_refs_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'commit-inverted',
          'connector:slack',
          'connector:slack:seq:4-3',
          4,
          3,
          'changed',
          '[]',
          '["raw:slack:event-3"]',
          1710000000003
        )
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      db
        .prepare(
          `INSERT INTO vnext_operator_commits (
            commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
            status, changed_refs_json, source_refs_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'commit-missing-cursor',
          'connector:discord',
          'connector:discord:seq:1-1',
          1,
          1,
          'changed',
          '[]',
          '["raw:discord:event-1"]',
          1710000000004
        )
    ).toThrow(/FOREIGN KEY constraint/i);

    db.close();
  });

  it('AC: enforces worker proposal confidence, status, and accepted timestamp contract', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 38);

    db.prepare(
      `INSERT INTO worker_proposals (
        proposal_id, worker_id, kind, payload_json, source_refs_json, confidence,
        status, created_at_ms, accepted_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'proposal-1',
      'worker-1',
      'memory_hint',
      '{}',
      '["context_packet:packet-1"]',
      0.75,
      'accepted',
      1710000000000,
      1710000000000
    );

    expect(() =>
      db
        .prepare(
          `INSERT INTO worker_proposals (
            proposal_id, worker_id, kind, payload_json, source_refs_json, confidence,
            status, created_at_ms, accepted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'proposal-bad-confidence',
          'worker-1',
          'memory_hint',
          '{}',
          '["context_packet:packet-1"]',
          1.5,
          'proposed',
          1710000000000,
          null
        )
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      db
        .prepare(
          `INSERT INTO worker_proposals (
            proposal_id, worker_id, kind, payload_json, source_refs_json, confidence,
            status, created_at_ms, accepted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'proposal-bad-time',
          'worker-1',
          'memory_hint',
          '{}',
          '["context_packet:packet-1"]',
          0.5,
          'accepted',
          1710000000001,
          1710000000000
        )
    ).toThrow(/CHECK constraint/i);

    db.close();
  });
});
