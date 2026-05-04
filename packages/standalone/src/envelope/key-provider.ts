import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { EnvelopeKeyLookup, EnvelopeSigningKey } from './signature.js';

type EnvLike = Record<string, string | undefined>;
const LOCAL_ENVELOPE_KEY_ID = 'local-generated';
const LOCAL_ENVELOPE_KEY_VERSION = 1;

interface StoredEnvelopeKey {
  key_id?: string;
  key_version?: number;
  key_base64?: string;
}

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
  if (key.length < 32) {
    throw new Error('[envelope] HMAC key must be at least 32 bytes');
  }

  const keyVersion = Number(env.MAMA_ENVELOPE_HMAC_KEY_VERSION ?? '1');
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new Error('[envelope] MAMA_ENVELOPE_HMAC_KEY_VERSION must be a positive integer');
  }

  const rawKeyId = env.MAMA_ENVELOPE_HMAC_KEY_ID;
  const trimmedKeyId = rawKeyId?.trim();
  if (trimmedKeyId === '') {
    throw new Error('[envelope] MAMA_ENVELOPE_HMAC_KEY_ID must not be empty');
  }
  const keyId = trimmedKeyId ?? 'default';

  return {
    key_id: keyId,
    key_version: keyVersion,
    key,
  };
}

export function loadOrCreateLocalEnvelopeSigningKey(
  env: EnvLike = process.env
): EnvelopeSigningKey {
  if (env.MAMA_ENVELOPE_HMAC_KEY_BASE64 || env.MAMA_ENVELOPE_HMAC_KEY) {
    return loadEnvelopeSigningKeyFromEnv(env);
  }

  const keyPath = localEnvelopeKeyPath(env);
  mkdirSync(dirname(keyPath), { recursive: true });
  const stored: Required<StoredEnvelopeKey> = {
    key_id: LOCAL_ENVELOPE_KEY_ID,
    key_version: LOCAL_ENVELOPE_KEY_VERSION,
    key_base64: randomBytes(32).toString('base64'),
  };
  try {
    // Atomic create: only the first concurrent caller wins the write; others
    // get EEXIST and load the key the winner persisted, avoiding a TOCTOU
    // race where two processes generate different keys.
    writeFileSync(keyPath, `${JSON.stringify(stored, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return storedEnvelopeKeyToSigningKey(stored, keyPath);
  } catch (error) {
    if (isFileAlreadyExistsError(error)) {
      return readStoredEnvelopeKey(keyPath);
    }
    throw error;
  }
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

export function makeEnvKeyLookup(active: EnvelopeSigningKey): EnvelopeKeyLookup {
  return (keyId, keyVersion) =>
    keyId === active.key_id && keyVersion === active.key_version ? active.key : undefined;
}

function localEnvelopeKeyPath(env: EnvLike): string {
  if (env.MAMA_ENVELOPE_KEY_PATH?.trim()) {
    return resolve(expandHome(env.MAMA_ENVELOPE_KEY_PATH.trim(), env));
  }
  return join(homeFromEnv(env), '.mama', 'envelope-key.json');
}

function homeFromEnv(env: EnvLike): string {
  return env.HOME?.trim() || homedir();
}

function expandHome(value: string, env: EnvLike): string {
  return value.replace(/^~(?=$|\/)/, homeFromEnv(env));
}

function readStoredEnvelopeKey(keyPath: string): EnvelopeSigningKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[envelope] Failed to read local envelope key ${keyPath}: ${message}`);
  }
  return storedEnvelopeKeyToSigningKey(parsed as StoredEnvelopeKey, keyPath);
}

function storedEnvelopeKeyToSigningKey(
  stored: StoredEnvelopeKey,
  keyPath: string
): EnvelopeSigningKey {
  if (!stored || typeof stored !== 'object') {
    throw new Error(`[envelope] Local envelope key ${keyPath} must be a JSON object`);
  }
  if (!stored.key_base64) {
    throw new Error(`[envelope] Local envelope key ${keyPath} is missing key_base64`);
  }
  const key = decodeStrictBase64(stored.key_base64);
  if (key.length < 32) {
    throw new Error(`[envelope] Local envelope key ${keyPath} must be at least 32 bytes`);
  }
  const keyVersion = Number(stored.key_version ?? LOCAL_ENVELOPE_KEY_VERSION);
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new Error(`[envelope] Local envelope key ${keyPath} has invalid key_version`);
  }
  const keyId = stored.key_id?.trim() || LOCAL_ENVELOPE_KEY_ID;
  return {
    key_id: keyId,
    key_version: keyVersion,
    key,
  };
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
