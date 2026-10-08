import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationsThrough } from '../helpers/test-utils.js';

describe('migration 103', () => {
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
