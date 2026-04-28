import { signEnvelope } from '../../src/envelope/signature.js';
import { applyEnvelopeTablesMigration } from '../../src/db/migrations/envelope-tables.js';
import { EnvelopeAuthority } from '../../src/envelope/authority.js';
import { EnvelopeStore } from '../../src/envelope/store.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';
import type { Envelope } from '../../src/envelope/types.js';

export const TEST_KEY = Buffer.from('test-envelope-key-32-bytes-long!');
export const TEST_SIGNING_KEY = {
  key_id: 'default',
  key_version: 1,
  key: TEST_KEY,
};

export function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    agent_id: 'worker',
    instance_id: `inst_${Math.random().toString(36).slice(2, 10)}`,
    source: 'telegram',
    channel_id: 'tg:1',
    trigger_context: {},
    scope: {
      project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
      raw_connectors: ['telegram'],
      memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
    },
    tier: 1,
    budget: { wall_seconds: 10 },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    envelope_hash: '',
    ...overrides,
  };
}

export function makeSignedEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return signEnvelope(makeEnvelope(overrides), TEST_SIGNING_KEY);
}

export function makeAuthorityHarness(db: SQLiteDatabase): {
  authority: EnvelopeAuthority;
  store: EnvelopeStore;
  keyLookup: (keyId: string, keyVersion: number) => Buffer | undefined;
} {
  applyEnvelopeTablesMigration(db);
  const store = new EnvelopeStore(db);
  const keyLookup = (keyId: string, keyVersion: number): Buffer | undefined =>
    keyId === TEST_SIGNING_KEY.key_id && keyVersion === TEST_SIGNING_KEY.key_version
      ? TEST_KEY
      : undefined;
  const authority = new EnvelopeAuthority(store, TEST_SIGNING_KEY, keyLookup);
  return { authority, store, keyLookup };
}
