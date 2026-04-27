import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { canonicalEnvelopeJson } from '../../src/envelope/canonical.js';
import { verifyEnvelope } from '../../src/envelope/signature.js';
import type { Envelope } from '../../src/envelope/types.js';
import { makeAuthorityHarness, makeEnvelope, makeSignedEnvelope } from './fixtures.js';

describe('envelope trust boundary: no silent fallback', () => {
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    () => undefined,
    Symbol('x'),
    BigInt(1),
  ])('canonicalization throws for invalid value %s', (badValue) => {
    const env = {
      ...makeEnvelope(),
      trigger_context: { badValue },
    } as unknown as Envelope;

    expect(() => canonicalEnvelopeJson(env)).toThrow();
  });

  it('verifyEnvelope throws for malformed persisted signature hmac', () => {
    const signed = makeSignedEnvelope();
    const env: Envelope = {
      ...signed,
      signature: { hmac: 'not base64!!!!', key_id: 'default', key_version: 1 },
    };

    expect(() => verifyEnvelope(env, () => Buffer.alloc(32))).toThrow(/signature|base64/i);
  });

  it('authority loadVerified raises explicit error for corrupted persisted signature', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-neg-'));
    const db = new Database(join(dir, 't.db'));
    const { authority } = makeAuthorityHarness(db);

    try {
      const env = authority.buildAndPersist(makeEnvelope());

      db.prepare('UPDATE envelopes SET signature = ? WHERE envelope_hash = ?').run(
        JSON.stringify({ hmac: 'not base64!!!!', key_id: 'default', key_version: 1 }),
        env.envelope_hash
      );

      expect(() => authority.loadVerified(env.envelope_hash)).toThrow(/signature|base64|hmac/i);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
