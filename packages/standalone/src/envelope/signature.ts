import { createHmac, timingSafeEqual } from 'node:crypto';
import { computeEnvelopeHash } from './canonical.js';
import type { Envelope } from './types.js';

export type EnvelopeKeyMaterial = Buffer | Uint8Array | string;

export interface EnvelopeSigningKey {
  key_id: string;
  key_version: number;
  key: EnvelopeKeyMaterial;
}

export type EnvelopeKeyLookup = (
  keyId: string,
  keyVersion: number
) => EnvelopeKeyMaterial | undefined;

export function signEnvelope(envelope: Envelope, signingKey: EnvelopeSigningKey): Envelope {
  validateSigningKey(signingKey);

  const envelopeHash = computeEnvelopeHash(envelope);
  if (envelope.envelope_hash && envelope.envelope_hash !== envelopeHash) {
    throw new Error(
      `[envelope-signature] Refusing to sign stale envelope_hash: ` +
        `${envelope.envelope_hash} !== ${envelopeHash}`
    );
  }

  return {
    ...envelope,
    envelope_hash: envelopeHash,
    signature: {
      hmac: computeSignatureHmac(envelopeHash, signingKey.key),
      key_id: signingKey.key_id,
      key_version: signingKey.key_version,
    },
  };
}

export function verifyEnvelope(envelope: Envelope, lookupKey: EnvelopeKeyLookup): boolean {
  if (!envelope.signature) {
    return false;
  }

  const envelopeHash = computeEnvelopeHash(envelope);
  if (envelope.envelope_hash !== envelopeHash) {
    return false;
  }

  const key = lookupKey(envelope.signature.key_id, envelope.signature.key_version);
  if (!key) {
    return false;
  }

  const expected = decodeBase64Signature(computeSignatureHmac(envelope.envelope_hash, key));
  const actual = decodeBase64Signature(envelope.signature.hmac);

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

export function assertEnvelopeSignature(envelope: Envelope, lookupKey: EnvelopeKeyLookup): void {
  if (!verifyEnvelope(envelope, lookupKey)) {
    throw new Error(
      `[envelope-signature] Envelope signature verification failed for ` +
        `${envelope.instance_id} (${envelope.envelope_hash || 'missing hash'})`
    );
  }
}

function validateSigningKey(signingKey: EnvelopeSigningKey): void {
  if (!signingKey.key_id) {
    throw new Error('[envelope-signature] key_id is required');
  }
  if (!Number.isInteger(signingKey.key_version) || signingKey.key_version < 1) {
    throw new Error('[envelope-signature] key_version must be a positive integer');
  }
  if (normalizeKey(signingKey.key).length === 0) {
    throw new Error('[envelope-signature] key material must not be empty');
  }
}

function computeSignatureHmac(envelopeHash: string, key: EnvelopeKeyMaterial): string {
  return createHmac('sha256', normalizeKey(key)).update(envelopeHash, 'utf8').digest('base64');
}

function normalizeKey(key: EnvelopeKeyMaterial): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(key);
}

function decodeBase64Signature(value: string): Buffer {
  if (!isStrictBase64(value)) {
    throw new Error('[envelope-signature] Persisted signature hmac must be strict base64');
  }
  return Buffer.from(value, 'base64');
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
