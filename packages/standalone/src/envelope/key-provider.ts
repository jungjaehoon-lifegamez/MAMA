import type { EnvelopeKeyLookup, EnvelopeSigningKey } from './signature.js';

type EnvLike = Record<string, string | undefined>;

export function loadEnvelopeSigningKeyFromEnv(env: EnvLike = process.env): EnvelopeSigningKey {
  const rawBase64 = env.MAMA_ENVELOPE_HMAC_KEY_BASE64;
  const rawUtf8 = env.MAMA_ENVELOPE_HMAC_KEY;

  if (!rawBase64 && !rawUtf8) {
    throw new Error(
      '[envelope] MAMA_ENVELOPE_HMAC_KEY_BASE64 or MAMA_ENVELOPE_HMAC_KEY is required ' +
        'when envelope issuance is enabled'
    );
  }

  const key = rawBase64 ? decodeStrictBase64(rawBase64) : Buffer.from(rawUtf8!, 'utf8');
  if (key.length < 16) {
    throw new Error('[envelope] HMAC key must be at least 16 bytes');
  }

  const keyVersion = Number(env.MAMA_ENVELOPE_HMAC_KEY_VERSION ?? '1');
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new Error('[envelope] MAMA_ENVELOPE_HMAC_KEY_VERSION must be a positive integer');
  }

  const rawKeyId = env.MAMA_ENVELOPE_HMAC_KEY_ID;
  if (rawKeyId === '') {
    throw new Error('[envelope] MAMA_ENVELOPE_HMAC_KEY_ID must not be empty');
  }
  const keyId = rawKeyId ?? 'default';

  return {
    key_id: keyId,
    key_version: keyVersion,
    key,
  };
}

export function makeEnvKeyLookup(active: EnvelopeSigningKey): EnvelopeKeyLookup {
  return (keyId, keyVersion) =>
    keyId === active.key_id && keyVersion === active.key_version ? active.key : undefined;
}

function decodeStrictBase64(raw: string): Buffer {
  if (raw !== raw.trim()) {
    throw new Error('[envelope] MAMA_ENVELOPE_HMAC_KEY_BASE64 must be canonical base64');
  }
  if (raw.length === 0 || raw.length % 4 !== 0 || !isBase64(raw)) {
    throw new Error('[envelope] MAMA_ENVELOPE_HMAC_KEY_BASE64 must be valid base64');
  }

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.toString('base64') !== raw) {
    throw new Error('[envelope] MAMA_ENVELOPE_HMAC_KEY_BASE64 must be canonical base64');
  }
  return decoded;
}

function isBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
