import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { applyEnvelopeTablesMigration } from '../../src/db/migrations/envelope-tables.js';
import { EnvelopeStore } from '../../src/envelope/store.js';
import { TEST_KEY, makeEnvelope, makeSignedEnvelope } from './fixtures.js';

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

  it('allows idempotent duplicate when JSON object key order differs', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);
    const env = makeSignedEnvelope({
      instance_id: 'inst_stable_duplicate',
      trigger_context: {
        user_text: 'sync this',
        watch_event: { type: 'file', raw_id: 'evt-1', path: '/workspace/a.ts' },
      },
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
        as_of: '2026-04-27T00:00:00.000Z',
        eval_privileged: false,
      },
      budget: { wall_seconds: 10, token_limit: 1000, cost_cap: 1 },
    });
    const reordered = makeSignedEnvelope({
      instance_id: 'inst_stable_duplicate',
      trigger_context: {
        watch_event: { path: '/workspace/a.ts', raw_id: 'evt-1', type: 'file' },
        user_text: 'sync this',
      },
      scope: {
        eval_privileged: false,
        as_of: '2026-04-27T00:00:00.000Z',
        allowed_destinations: [{ id: 'tg:1', kind: 'telegram' }],
        memory_scopes: [{ id: '/workspace/project-a', kind: 'project' }],
        raw_connectors: ['telegram'],
        project_refs: [{ id: '/workspace/project-a', kind: 'project' }],
      },
      budget: { cost_cap: 1, token_limit: 1000, wall_seconds: 10 },
    });
    reordered.signature = {
      key_version: reordered.signature!.key_version,
      hmac: reordered.signature!.hmac,
      key_id: reordered.signature!.key_id,
    };

    try {
      expect(reordered.envelope_hash).toBe(env.envelope_hash);
      store.insert(env);
      expect(() => store.insert(reordered)).not.toThrow();
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

  it('reports duplicate conflict instead of throwing on nullable stored signature', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);
    const env = makeSignedEnvelope();

    try {
      store.insert(env);
      db.prepare('UPDATE envelopes SET signature = NULL WHERE envelope_hash = ?').run(
        env.envelope_hash
      );

      expect(() => store.insert(env)).toThrow(/EnvelopeStore\.insert conflict/);
      expect(() => store.insert(env)).not.toThrow(/unsupported value type: undefined/);
    } finally {
      closeDb(db, dir);
    }
  });

  it('uses an accurately named 32-byte shared test key', () => {
    expect(TEST_KEY.length).toBe(32);
  });

  it('rejects corrupted tier values with envelope_hash', () => {
    const { db, dir } = makeDb('mama-envstore-');
    const store = new EnvelopeStore(db);
    const env = makeSignedEnvelope();

    try {
      store.insert(env);
      db.prepare('PRAGMA ignore_check_constraints = ON').run();
      db.prepare('UPDATE envelopes SET tier = ? WHERE envelope_hash = ?').run(4, env.envelope_hash);
      db.prepare('PRAGMA ignore_check_constraints = OFF').run();

      expect(() => store.getByHash(env.envelope_hash)).toThrow(/tier/);
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
