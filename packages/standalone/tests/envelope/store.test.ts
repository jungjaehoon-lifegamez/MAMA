import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { applyEnvelopeTablesMigration } from '../../src/db/migrations/envelope-tables.js';
import { EnvelopeStore } from '../../src/envelope/store.js';
import { makeEnvelope, makeSignedEnvelope } from './fixtures.js';

describe('envelope migration', () => {
  it('creates envelopes and system_config_versions tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-envmig-'));
    const db = new Database(join(dir, 't.db'));

    try {
      applyEnvelopeTablesMigration(db);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('envelopes','system_config_versions')"
        )
        .all() as { name: string }[];

      expect(tables.map((table) => table.name).sort()).toEqual([
        'envelopes',
        'system_config_versions',
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EnvelopeStore', () => {
  it('insert + get by hash roundtrip for signed envelope', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);
    const env = makeSignedEnvelope();

    try {
      store.insert(env);

      const fetched = store.getByHash(env.envelope_hash);
      expect(fetched).toBeDefined();
      expect(fetched!.instance_id).toBe(env.instance_id);
      expect(fetched!.scope.raw_connectors).toEqual(['telegram']);
    } finally {
      closeDb(db, dir);
    }
  });

  it('insert + get by instance id roundtrip for signed envelope', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);
    const env = makeSignedEnvelope();

    try {
      store.insert(env);

      const fetched = store.getByInstanceId(env.instance_id);
      expect(fetched?.envelope_hash).toBe(env.envelope_hash);
    } finally {
      closeDb(db, dir);
    }
  });

  it('rejects unsigned direct insert', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);

    try {
      expect(() => store.insert(makeEnvelope())).toThrow(/must be signed/i);
    } finally {
      closeDb(db, dir);
    }
  });

  it('allows exact idempotent duplicate but rejects conflicting duplicate', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);
    const env = makeSignedEnvelope();

    try {
      store.insert(env);
      expect(() => store.insert(env)).not.toThrow();

      const conflicting = {
        ...env,
        instance_id: `${env.instance_id}_other`,
      };
      expect(() => store.insert(conflicting)).toThrow(/duplicate|conflict|mismatch/i);
    } finally {
      closeDb(db, dir);
    }
  });

  it('reports corrupted JSON field with envelope_hash', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);
    const env = makeSignedEnvelope();

    try {
      store.insert(env);
      db.prepare('UPDATE envelopes SET scope = ? WHERE envelope_hash = ?').run(
        '{bad json',
        env.envelope_hash
      );

      expect(() => store.getByHash(env.envelope_hash)).toThrow(/scope/);
      expect(() => store.getByHash(env.envelope_hash)).toThrow(new RegExp(env.envelope_hash));
    } finally {
      closeDb(db, dir);
    }
  });
});

function makeDb(prefix: string): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = new Database(join(dir, 't.db'));
  applyEnvelopeTablesMigration(db);
  return { db, dir };
}

function closeDb(db: Database, dir: string): void {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
