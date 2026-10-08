import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationsThrough } from '../helpers/test-utils.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

function rerun103(
  change: (db: Database.Database) => void,
  check: (adapter: NodeSQLiteAdapter) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'partial-erasure-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  const adapter = new NodeSQLiteAdapter({ dbPath });
  try {
    applyMigrationsThrough(db, 103);
    db.exec('DELETE FROM schema_version WHERE version=103');
    change(db);
    db.close();
    adapter.connect();
    check(adapter);
  } finally {
    if (db.open) db.close();
    adapter.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function replaceTable(db: Database.Database, table: string, change: (sql: string) => string): void {
  const { sql } = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string };
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE ${table}; ${change(sql)}`);
}

describe('migration 103', () => {
  it('skips rebuilding only complete 103 tables, preserving consumer extensions', () => {
    rerun103(
      (db) => db.exec('ALTER TABLE observation_versions ADD COLUMN consumer_note TEXT'),
      (adapter) => {
        const before = adapter
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('judgment_commands','source_commands','observation_versions') ORDER BY name"
          )
          .all();
        expect(() => adapter.runMigrations(join(__dirname, '../../db/migrations'))).not.toThrow();
        expect(
          adapter
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('judgment_commands','source_commands','observation_versions') ORDER BY name"
            )
            .all()
        ).toEqual(before);
        expect(
          adapter.prepare('SELECT version FROM schema_version WHERE version=103').get()
        ).toEqual({ version: 103 });
      }
    );
  });

  it.each(['judgment_commands', 'source_commands', 'observation_versions'])(
    'fails loud naming %s when erased_at exists but the erasure CHECK is missing',
    (table) => {
      rerun103(
        (db) =>
          replaceTable(db, table, (sql) => {
            if (table === 'observation_versions') {
              return (
                sql.slice(0, sql.lastIndexOf('CHECK (\n')) +
                'CHECK ((body IS NOT NULL AND body_location_json IS NULL) OR (body IS NULL AND body_location_json IS NOT NULL)))'
              );
            }
            return sql.replace(
              /,\s*CHECK \((?:record_id|observation_id) IS NOT NULL OR erased_at IS NOT NULL\)/,
              ''
            );
          }),
        (adapter) => {
          expect(() => adapter.runMigrations(join(__dirname, '../../db/migrations'))).toThrow(
            new RegExp(`103.*${table}`)
          );
          expect(
            adapter.prepare('SELECT version FROM schema_version WHERE version=103').get()
          ).toBeUndefined();
        }
      );
    }
  );

  it.each([
    ['judgment_commands', 'record_id'],
    ['source_commands', 'observation_id'],
    ['observation_versions', 'source'],
    ['observation_versions', 'source_id'],
    ['observation_versions', 'content_hash'],
  ])('fails loud naming %s when its %s remains NOT NULL', (table, column) => {
    rerun103(
      (db) =>
        replaceTable(db, table, (sql) =>
          sql.replace(new RegExp(`\\b${column} TEXT\\b`), `${column} TEXT NOT NULL`)
        ),
      (adapter) => {
        expect(() => adapter.runMigrations(join(__dirname, '../../db/migrations'))).toThrow(
          new RegExp(`103.*${table}`)
        );
      }
    );
  });

  it('rejects an observation table retaining the old body XOR alongside the erasure CHECK', () => {
    rerun103(
      (db) =>
        replaceTable(
          db,
          'observation_versions',
          (sql) =>
            sql.slice(0, sql.lastIndexOf(')')) +
            ', CHECK ((body IS NOT NULL AND body_location_json IS NULL) OR (body IS NULL AND body_location_json IS NOT NULL)))'
        ),
      (adapter) => {
        expect(() => adapter.runMigrations(join(__dirname, '../../db/migrations'))).toThrow(
          /103.*observation_versions/
        );
      }
    );
  });

  it('supports bodyless observations and payloadless receipts while preserving populated FK children and both text indexes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      applyMigrationsThrough(db, 102);
      db.exec(
        "INSERT INTO decisions (id, topic, decision) VALUES ('test-record', 'test-topic', 'test text')"
      );
      db.exec(
        "INSERT INTO memory_scopes (id, kind, external_id) VALUES ('user:test-member', 'user', 'test-member')"
      );
      db.exec(
        "INSERT INTO memory_scope_bindings (memory_id, scope_id) VALUES ('test-record', 'user:test-member')"
      );
      db.exec(
        "INSERT INTO command_bindings VALUES ('test-command', 'test-member', 'judgment.append', 'test-hash', 'judgment', 'test-record', 1)"
      );
      db.exec("INSERT INTO judgment_commands VALUES ('test-command', 'test-record', 1, '{}', 1)");
      db.exec(
        "INSERT INTO observation_versions (observation_id, source, source_id, body, observed_at, content_hash, metadata_json, scope_json) VALUES ('test-observation', 'test-source', 'test-source-id', 'test body', 1, 'test-hash', '{}', '{}')"
      );
      const before = db.prepare('SELECT * FROM memory_scope_bindings').all();
      applyMigrationsThrough(db, 103, 103);
      expect(db.prepare('SELECT 1 FROM schema_version WHERE version=103').get()).toBeDefined();
      expect(db.prepare('SELECT * FROM memory_scope_bindings').all()).toEqual(before);
      db.exec(
        "UPDATE decisions SET erased_at=2, topic='', decision='', reasoning=NULL WHERE id='test-record'"
      );
      db.exec(
        "UPDATE observation_versions SET erased_at=2, body=NULL, body_location_json=NULL, source=NULL, source_id=NULL, content_hash=NULL WHERE observation_id='test-observation'"
      );
      db.exec(
        "UPDATE judgment_commands SET record_id=NULL, receipt_json='{}', erased_at=2 WHERE command_id='test-command'"
      );
      for (const index of ['decisions_fts', 'decisions_trigram'])
        expect(db.prepare(`SELECT rowid FROM ${index} WHERE ${index} MATCH 'test'`).all()).toEqual(
          []
        );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() =>
        db.exec(
          "INSERT INTO observation_versions (observation_id, source, source_id, observed_at, content_hash, metadata_json, scope_json) VALUES ('invalid', 'test', 'test', 1, 'hash', '{}', '{}')"
        )
      ).toThrow(/CHECK/);
      expect(() =>
        db.exec(
          "INSERT INTO judgment_commands (command_id, record_id, committed_watermark, receipt_json, created_at) VALUES ('test-command-2', NULL, 1, '{}', 1)"
        )
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
