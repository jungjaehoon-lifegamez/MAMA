import { describe, expect, it } from 'vitest';
import { computeEnvelopeHash } from '../../src/envelope/canonical.js';
import {
  assertEnvelopeSignature,
  signEnvelope,
  verifyEnvelope,
} from '../../src/envelope/signature.js';
import type { Envelope } from '../../src/envelope/types.js';

const KEY_V1 = Buffer.from('key-v1-32-bytes-secret-padded--');
const KEY_V2 = Buffer.from('key-v2-32-bytes-different-secret');

const keystore = new Map<string, Buffer>([
  ['default:1', KEY_V1],
  ['default:2', KEY_V2],
]);

const lookup = (keyId: string, keyVersion: number): Buffer | undefined =>
  keystore.get(`${keyId}:${keyVersion}`);

function baseEnvelope(): Envelope {
  return {
    agent_id: 'worker',
    instance_id: 'inst_01',
    source: 'cron',
    trigger_context: { scheduled_at: '2026-04-26T00:00:00Z' },
    scope: {
      project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
      raw_connectors: [],
      memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      allowed_destinations: [],
    },
    tier: 3,
    budget: { wall_seconds: 60 },
    expires_at: '2026-04-26T01:00:00Z',
    envelope_hash: '',
  };
}

describe('envelope signature', () => {
  it('sign + verify roundtrip with same key', () => {
    const signed = signEnvelope(baseEnvelope(), {
      key_id: 'default',
      key_version: 1,
      key: KEY_V1,
    });

    expect(signed.envelope_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.signature).toEqual({
      hmac: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      key_id: 'default',
      key_version: 1,
    });
    expect(verifyEnvelope(signed, lookup)).toBe(true);
    expect(() => assertEnvelopeSignature(signed, lookup)).not.toThrow();
  });

  it('supports key rotation by verifying persisted key_version', () => {
    const signedV1 = signEnvelope(baseEnvelope(), {
      key_id: 'default',
      key_version: 1,
      key: KEY_V1,
    });
    const signedV2 = signEnvelope(baseEnvelope(), {
      key_id: 'default',
      key_version: 2,
      key: KEY_V2,
    });

    expect(signedV1.signature?.hmac).not.toBe(signedV2.signature?.hmac);
    expect(verifyEnvelope(signedV1, lookup)).toBe(true);
    expect(verifyEnvelope(signedV2, lookup)).toBe(true);
  });

  it('returns false when envelope content is tampered after signing', () => {
    const signed = signEnvelope(baseEnvelope(), {
      key_id: 'default',
      key_version: 1,
      key: KEY_V1,
    });
    const tampered: Envelope = {
      ...signed,
      scope: {
        ...signed.scope,
        raw_connectors: ['telegram'],
      },
    };

    expect(verifyEnvelope(tampered, lookup)).toBe(false);
    expect(() => assertEnvelopeSignature(tampered, lookup)).toThrow(/hash|signature/i);
  });

  it('returns false when key lookup misses persisted key', () => {
    const signed = signEnvelope(baseEnvelope(), {
      key_id: 'missing',
      key_version: 1,
      key: KEY_V1,
    });

    expect(verifyEnvelope(signed, lookup)).toBe(false);
  });

  it('throws when signing an envelope with stale envelope_hash', () => {
    const env = { ...baseEnvelope(), envelope_hash: 'f'.repeat(64) };

    expect(() =>
      signEnvelope(env, {
        key_id: 'default',
        key_version: 1,
        key: KEY_V1,
      })
    ).toThrow(/envelope_hash/i);
  });

  it('returns false for unsigned envelopes', () => {
    const env = baseEnvelope();
    env.envelope_hash = computeEnvelopeHash(env);

    expect(verifyEnvelope(env, lookup)).toBe(false);
  });

  it('throws on malformed persisted signature hmac', () => {
    const signed = signEnvelope(baseEnvelope(), {
      key_id: 'default',
      key_version: 1,
      key: KEY_V1,
    });
    const corrupted: Envelope = {
      ...signed,
      signature: { ...signed.signature!, hmac: 'not base64!' },
    };

    expect(() => verifyEnvelope(corrupted, lookup)).toThrow(/base64|signature/i);
  });
});
