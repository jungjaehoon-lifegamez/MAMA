import { describe, expect, it } from 'vitest';
import {
  loadEnvelopeSigningKeyFromEnv,
  makeEnvKeyLookup,
} from '../../src/envelope/key-provider.js';

describe('EnvelopeKeyProvider', () => {
  it('throws when envelope key is missing', () => {
    expect(() => loadEnvelopeSigningKeyFromEnv({})).toThrow(/MAMA_ENVELOPE_HMAC_KEY/i);
  });

  it('loads explicit active key from environment', () => {
    const activeKey = Buffer.alloc(32, 1);
    const signer = loadEnvelopeSigningKeyFromEnv({
      MAMA_ENVELOPE_HMAC_KEY_BASE64: activeKey.toString('base64'),
      MAMA_ENVELOPE_HMAC_KEY_ID: 'local',
      MAMA_ENVELOPE_HMAC_KEY_VERSION: '7',
    });

    expect(signer.key_id).toBe('local');
    expect(signer.key_version).toBe(7);
    expect(Buffer.from(signer.key).equals(activeKey)).toBe(true);
  });

  it('loads explicit UTF-8 key from environment', () => {
    const signer = loadEnvelopeSigningKeyFromEnv({
      MAMA_ENVELOPE_HMAC_KEY: 'this-is-a-32-byte-envelope-key!!',
      MAMA_ENVELOPE_HMAC_KEY_ID: 'utf8',
    });

    expect(signer.key_id).toBe('utf8');
    expect(Buffer.from(signer.key).toString('utf8')).toBe('this-is-a-32-byte-envelope-key!!');
  });

  it('rejects malformed base64 instead of silently decoding garbage', () => {
    expect(() =>
      loadEnvelopeSigningKeyFromEnv({
        MAMA_ENVELOPE_HMAC_KEY_BASE64: 'not base64!!!',
      })
    ).toThrow(/base64/i);
  });

  it('rejects non-canonical base64 instead of silently accepting it', () => {
    expect(() =>
      loadEnvelopeSigningKeyFromEnv({
        MAMA_ENVELOPE_HMAC_KEY_BASE64: 'AQ==\n',
      })
    ).toThrow(/base64/i);
  });

  it('rejects short HMAC keys', () => {
    expect(() =>
      loadEnvelopeSigningKeyFromEnv({
        MAMA_ENVELOPE_HMAC_KEY_BASE64: Buffer.alloc(31, 1).toString('base64'),
      })
    ).toThrow(/at least 32 bytes/i);
  });

  it('rejects invalid key versions', () => {
    expect(() =>
      loadEnvelopeSigningKeyFromEnv({
        MAMA_ENVELOPE_HMAC_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
        MAMA_ENVELOPE_HMAC_KEY_VERSION: '1.5',
      })
    ).toThrow(/positive integer/i);
  });

  it('rejects an explicitly empty key id', () => {
    expect(() =>
      loadEnvelopeSigningKeyFromEnv({
        MAMA_ENVELOPE_HMAC_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
        MAMA_ENVELOPE_HMAC_KEY_ID: '',
      })
    ).toThrow(/must not be empty/i);
  });

  it('key lookup only resolves the active configured key in P1', () => {
    const activeKey = Buffer.alloc(32, 2);
    const signer = loadEnvelopeSigningKeyFromEnv({
      MAMA_ENVELOPE_HMAC_KEY_BASE64: activeKey.toString('base64'),
      MAMA_ENVELOPE_HMAC_KEY_ID: 'local',
      MAMA_ENVELOPE_HMAC_KEY_VERSION: '1',
    });

    const lookup = makeEnvKeyLookup(signer);

    expect(Buffer.from(lookup('local', 1) ?? []).equals(activeKey)).toBe(true);
    expect(lookup('local', 2)).toBeUndefined();
    expect(lookup('other', 1)).toBeUndefined();
  });
});
