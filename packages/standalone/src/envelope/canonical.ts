import { createHash } from 'node:crypto';
import { ENVELOPE_HASH_EXCLUDED_FIELDS, type Envelope } from './types.js';

/**
 * Stable canonical JSON for envelope hashing per spec v2.3 section 4.4.
 *
 * Rules:
 * - Exclude `envelope_hash` and `signature` from the hash input.
 * - Sort object keys lexicographically at every nesting level.
 * - Emit no whitespace.
 * - Normalize string values to NFC.
 */
export function canonicalEnvelopeJson(envelope: Envelope): string {
  return canonicalize(stripExcluded(envelope));
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function computeEnvelopeHash(envelope: Envelope): string {
  return createHash('sha256').update(canonicalEnvelopeJson(envelope)).digest('hex');
}

function stripExcluded(envelope: Envelope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if ((ENVELOPE_HASH_EXCLUDED_FIELDS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Envelope canonical JSON requires finite numbers, got ${String(value)}`);
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value.normalize('NFC'));
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new Error('Envelope canonical JSON only supports JSON-safe plain objects');
    }

    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`);
    return `{${parts.join(',')}}`;
  }

  throw new Error(`Envelope canonical JSON received unsupported value type: ${typeof value}`);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
