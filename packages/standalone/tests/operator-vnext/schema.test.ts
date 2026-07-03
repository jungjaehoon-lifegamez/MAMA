import { describe, expect, it } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import Database from '../../src/sqlite.js';
import { ensureVNextOperatorSchema } from '../../src/operator-vnext/schema.js';

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

function tableSql(db: Database, tableName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

describe('STORY-VNEXT-PR3-OPERATOR-BOOTSTRAP: operator schema bootstrap', () => {
  describe('AC: sessions DB gets the primary operator contract before runtime creation', () => {
    it('installs the vNext operator tables into an empty sessions database idempotently', () => {
      const db = new Database(':memory:');

      ensureVNextOperatorSchema(db);
      ensureVNextOperatorSchema(db);

      expect(tableExists(db, 'schema_version')).toBe(true);
      expect(tableExists(db, 'vnext_operator_cursors')).toBe(true);
      expect(tableExists(db, 'vnext_operator_commits')).toBe(true);
      expect(tableExists(db, 'operator_no_updates')).toBe(true);
      expect(tableExists(db, 'worker_proposals')).toBe(true);
      expect(tableExists(db, 'operator_memory_commit_intents')).toBe(true);
      expect(
        db.prepare('SELECT version, description FROM schema_version WHERE version = 38').get()
      ).toEqual({
        version: 38,
        description: 'Create vNext operator contracts',
      });
      expect(
        db.prepare('SELECT version, description FROM schema_version WHERE version = 40').get()
      ).toBeUndefined();

      db.close();
    });

    it('repairs legacy schema_version tables before installing operator tables', () => {
      const db = new Database(':memory:');
      db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');

      ensureVNextOperatorSchema(db);

      expect(
        db.prepare('SELECT version, description FROM schema_version WHERE version = 38').get()
      ).toEqual({
        version: 38,
        description: 'Create vNext operator contracts',
      });
      expect(tableExists(db, 'vnext_operator_cursors')).toBe(true);
      expect(tableExists(db, 'operator_memory_commit_intents')).toBe(true);

      db.close();
    });

    it('skips migration file reads when the operator schema is already installed', () => {
      const missingSchemaDb = new Database(':memory:');
      expect(() =>
        ensureVNextOperatorSchema(missingSchemaDb, {
          readMigrationSql: () => 'not valid sql',
        })
      ).toThrow(/syntax/i);
      missingSchemaDb.close();

      const installedSchemaDb = new Database(':memory:');
      ensureVNextOperatorSchema(installedSchemaDb);

      expect(() =>
        ensureVNextOperatorSchema(installedSchemaDb, {
          readMigrationSql: () => {
            throw new Error('migration file should not be read');
          },
        })
      ).not.toThrow();

      installedSchemaDb.close();
    });

    it('rolls back schema repairs if operator schema installation fails', () => {
      const db = new Database(':memory:');
      db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');

      expect(() =>
        ensureVNextOperatorSchema(db, {
          readMigrationSql: () => 'not valid sql',
        })
      ).toThrow(/syntax/i);

      expect(tableExists(db, 'vnext_operator_cursors')).toBe(false);
      expect(
        (db.prepare('PRAGMA table_info(schema_version)').all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      ).toEqual(['version']);

      db.close();
    });

    it('rejects partial schemas that claim the operator migration version', () => {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER DEFAULT (unixepoch() * 1000),
          description TEXT
        );
        INSERT INTO schema_version (version, description)
        VALUES (38, 'Create vNext operator contracts');
        CREATE TABLE vnext_operator_cursors (
          cursor_name TEXT PRIMARY KEY,
          last_change_seq INTEGER NOT NULL DEFAULT 0,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE vnext_operator_commits (
          commit_id TEXT PRIMARY KEY
        );
        CREATE TABLE operator_no_updates (
          no_update_id TEXT PRIMARY KEY
        );
        CREATE TABLE worker_proposals (
          proposal_id TEXT PRIMARY KEY
        );
      `);

      expect(() => ensureVNextOperatorSchema(db)).toThrow(/vnext_operator_cursors/i);

      db.close();
    });

    it('rejects incompatible operator memory intent tables that claim migration 40', () => {
      const db = new Database(':memory:');
      ensureVNextOperatorSchema(db);
      db.exec(`
        DROP TABLE operator_memory_commit_intents;
        CREATE TABLE operator_memory_commit_intents (
          intent_id TEXT PRIMARY KEY,
          cursor_name TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          expected_memory_count INTEGER NOT NULL,
          memory_payload_hash TEXT NOT NULL,
          memory_ids_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX idx_operator_memory_commit_intents_cursor_created
          ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);
      `);

      expect(() => ensureVNextOperatorSchema(db)).toThrow(/operator_memory_commit_intents/i);

      db.close();
    });

    it('upgrades legacy operator memory intent tables before compatibility checks', () => {
      const db = new Database(':memory:');
      ensureVNextOperatorSchema(db);
      db.exec(`
        DROP TABLE operator_memory_commit_intents;
        CREATE TABLE operator_memory_commit_intents (
          intent_id TEXT PRIMARY KEY,
          cursor_name TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0),
          memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%'),
          memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json)),
          source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
          status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted')),
          claim_token TEXT,
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
        );
        CREATE INDEX idx_operator_memory_commit_intents_cursor_created
          ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);
        INSERT INTO operator_memory_commit_intents (
          intent_id, cursor_name, idempotency_key, expected_memory_count,
          memory_payload_hash, memory_ids_json, source_refs_json, status, claim_token,
          created_at_ms, updated_at_ms
        )
        VALUES
          (
            'intent:legacy-saving-without-claim',
            'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:6-6',
            1,
            'sha256:legacy-saving-without-claim',
            '[null]',
            '["raw:slack:synthetic-event-index-id"]',
            'saving',
            NULL,
            1710000000000,
            1710000000000
          ),
          (
            'intent:legacy-pending-with-claim',
            'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:7-7',
            1,
            'sha256:legacy-pending-with-claim',
            '[null]',
            '["raw:slack:synthetic-event-index-id"]',
            'pending',
            'claim:legacy',
            1710000000000,
            1710000000000
          );
      `);

      expect(() =>
        ensureVNextOperatorSchema(db, {
          readMigrationSql: () => {
            throw new Error('migration file should not be read');
          },
        })
      ).not.toThrow();

      const sql = tableSql(db, 'operator_memory_commit_intents');
      expect(sql).toContain("(status = 'saving' AND claim_token IS NOT NULL)");
      expect(sql).toContain("(status != 'saving' AND claim_token IS NULL)");
      expect(
        db
          .prepare(
            `SELECT status, claim_token
             FROM operator_memory_commit_intents
             WHERE intent_id = 'intent:legacy-saving-without-claim'`
          )
          .get()
      ).toEqual({ status: 'pending', claim_token: null });
      expect(
        db
          .prepare(
            `SELECT status, claim_token
             FROM operator_memory_commit_intents
             WHERE intent_id = 'intent:legacy-pending-with-claim'`
          )
          .get()
      ).toEqual({ status: 'pending', claim_token: null });

      db.close();
    });

    it('enforces operator memory commit intent constraints', () => {
      const db = new Database(':memory:');
      ensureVNextOperatorSchema(db);

      const insertIntent = db.prepare(
        `INSERT INTO operator_memory_commit_intents (
          intent_id, cursor_name, idempotency_key, expected_memory_count,
          memory_payload_hash, memory_ids_json, source_refs_json, status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertClaimedIntent = db.prepare(
        `INSERT INTO operator_memory_commit_intents (
          intent_id, cursor_name, idempotency_key, expected_memory_count,
          memory_payload_hash, memory_ids_json, source_refs_json, status, claim_token,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertIntent.run(
        'intent:valid',
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
        1,
        'sha256:valid',
        JSON.stringify(['memory-1']),
        JSON.stringify(['raw:slack:synthetic-event-index-id']),
        'saved',
        1710000000000,
        1710000000000
      );

      expect(() =>
        insertIntent.run(
          'intent:bad-count',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
          0,
          'sha256:bad-count',
          JSON.stringify([]),
          JSON.stringify(['raw:slack:synthetic-event-index-id']),
          'pending',
          1710000000000,
          1710000000000
        )
      ).toThrow();
      expect(() =>
        insertIntent.run(
          'intent:bad-json',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:3-3',
          1,
          'sha256:bad-json',
          'not-json',
          JSON.stringify(['raw:slack:synthetic-event-index-id']),
          'pending',
          1710000000000,
          1710000000000
        )
      ).toThrow();
      expect(() =>
        insertIntent.run(
          'intent:bad-status',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:4-4',
          1,
          'sha256:bad-status',
          JSON.stringify([null]),
          JSON.stringify(['raw:slack:synthetic-event-index-id']),
          'done',
          1710000000000,
          1710000000000
        )
      ).toThrow();
      expect(() =>
        insertIntent.run(
          'intent:bad-time',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:5-5',
          1,
          'sha256:bad-time',
          JSON.stringify([null]),
          JSON.stringify(['raw:slack:synthetic-event-index-id']),
          'pending',
          1710000000001,
          1710000000000
        )
      ).toThrow();
      expect(() =>
        insertIntent.run(
          'intent:duplicate-idempotency',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
          1,
          'sha256:duplicate-idempotency',
          JSON.stringify([null]),
          JSON.stringify(['raw:slack:synthetic-event-index-id']),
          'pending',
          1710000000000,
          1710000000000
        )
      ).toThrow();
      expect(() =>
        insertIntent.run(
          'intent:saving-without-claim',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:6-6',
          1,
          'sha256:saving-without-claim',
          JSON.stringify([null]),
          JSON.stringify(['raw:slack:synthetic-event-index-id']),
          'saving',
          1710000000000,
          1710000000000
        )
      ).toThrow();
      expect(() =>
        insertClaimedIntent.run(
          'intent:pending-with-claim',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:7-7',
          1,
          'sha256:pending-with-claim',
          JSON.stringify([null]),
          JSON.stringify(['raw:slack:synthetic-event-index-id']),
          'pending',
          'claim-token',
          1710000000000,
          1710000000000
        )
      ).toThrow();
      insertClaimedIntent.run(
        'intent:claimed-saving',
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:8-8',
        1,
        'sha256:claimed-saving',
        JSON.stringify([null]),
        JSON.stringify(['raw:slack:synthetic-event-index-id']),
        'saving',
        'claim-token',
        1710000000000,
        1710000000000
      );

      db.close();
    });
  });
});
