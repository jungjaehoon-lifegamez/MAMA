import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { applyEnvelopeTablesMigration } from '../../src/db/migrations/envelope-tables.js';
import { EnvelopeAuthority } from '../../src/envelope/authority.js';
import { EnvelopeStore } from '../../src/envelope/store.js';
import type { EnvelopeBuildInput } from '../../src/envelope/authority.js';

const KEY = Buffer.from('key-v1-32-bytes-secret-padded---');
const keyLookup = (keyId: string, keyVersion: number): Buffer | undefined =>
  keyId === 'default' && keyVersion === 1 ? KEY : undefined;

function buildInput(overrides: Partial<EnvelopeBuildInput> = {}): EnvelopeBuildInput {
  return {
    agent_id: 'worker',
    instance_id: `inst_${Math.random().toString(36).slice(2, 10)}`,
    source: 'telegram',
    channel_id: 'tg:1',
    trigger_context: { user_text: 'hi' },
    scope: {
      project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
      raw_connectors: ['telegram'],
      memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
    },
    tier: 1,
    budget: { wall_seconds: 10 },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('EnvelopeAuthority', () => {
  it('uses an accurately named 32-byte fixture key', () => {
    expect(KEY.length).toBe(32);
  });

  it('build always signs and assigns hash atomically', () => {
    const { auth, db, dir } = makeHarness();

    try {
      const env = auth.build(buildInput({ instance_id: 'inst_1' }));

      expect(env.envelope_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(env.signature).toBeDefined();
      expect(env.signature!.key_id).toBe('default');
    } finally {
      closeDb(db, dir);
    }
  });

  it('buildAndPersist + loadVerified roundtrip', () => {
    const { auth, db, dir } = makeHarness();

    try {
      const env = auth.buildAndPersist(
        buildInput({
          instance_id: 'inst_2',
          source: 'cron',
          channel_id: undefined,
          trigger_context: { scheduled_at: '2026-04-26T00:00:00Z' },
          scope: {
            project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
            raw_connectors: [],
            memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
            allowed_destinations: [],
          },
          tier: 3,
          budget: { wall_seconds: 60 },
        })
      );

      const loaded = auth.loadVerified(env.envelope_hash);
      expect(loaded).toBeDefined();
      expect(loaded!.instance_id).toBe('inst_2');
    } finally {
      closeDb(db, dir);
    }
  });

  it('loadVerified throws on signature mismatch', () => {
    const { auth, db, dir } = makeHarness();

    try {
      const env = auth.buildAndPersist(buildInput({ instance_id: 'inst_3' }));
      db.prepare('UPDATE envelopes SET scope = ? WHERE envelope_hash = ?').run(
        JSON.stringify({ ...env.scope, raw_connectors: ['telegram', 'slack'] }),
        env.envelope_hash
      );

      expect(() => auth.loadVerified(env.envelope_hash)).toThrow(/signature/i);
    } finally {
      closeDb(db, dir);
    }
  });

  it('returns undefined for missing envelope', () => {
    const { auth, db, dir } = makeHarness();

    try {
      expect(auth.loadVerified('0'.repeat(64))).toBeUndefined();
    } finally {
      closeDb(db, dir);
    }
  });

  it('build rejects invalid envelope input before signing', () => {
    const { auth, db, dir } = makeHarness();

    try {
      expect(() => auth.build(buildInput({ agent_id: '' }))).toThrow(/agent_id/);
      expect(() => auth.build(buildInput({ tier: 4 as 1 }))).toThrow(/tier/);
      expect(() => auth.build(buildInput({ budget: { wall_seconds: 0 } }))).toThrow(/wall_seconds/);
      expect(() =>
        auth.build(buildInput({ expires_at: new Date(Date.now() - 1_000).toISOString() }))
      ).toThrow(/past/);
      expect(() => auth.build(buildInput({ expires_at: '2099-01-01 00:00:00' }))).toThrow(
        /ISO 8601/
      );
    } finally {
      closeDb(db, dir);
    }
  });
});

function makeHarness(): { auth: EnvelopeAuthority; db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mama-auth-'));
  const db = new Database(join(dir, 't.db'));
  applyEnvelopeTablesMigration(db);
  const auth = new EnvelopeAuthority(
    new EnvelopeStore(db),
    { key_id: 'default', key_version: 1, key: KEY },
    keyLookup
  );
  return { auth, db, dir };
}

function closeDb(db: Database, dir: string): void {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
