/**
 * Canonical JSON serializer + SHA-256 hash for `case_corrections.target_ref`.
 *
 * Phase 1 of MAMA Case-First Memory System (spec §5.4 Option C).
 *
 * Behavior:
 * - recursively sort object keys in lexicographic UTF-8 order
 * - preserve array order (semantic)
 * - reject undefined values with typed error code `canonicalize.undefined_value`
 * - reject function values with typed error code `canonicalize.function_value`
 * - reject non-finite numbers (NaN, +/- Infinity) with `canonicalize.non_finite_number`
 * - serialize normalized value via JSON.stringify (after normalization)
 * - hash canonical JSON string with SHA-256 over UTF-8 bytes → 32-byte Buffer
 *
 * No top-level await. No ESM-only runtime dependency. Safe for CJS consumers
 * (mcp-server, claude-code-plugin) via package export `./canonicalize`.
 *
 * @module canonicalize
 */

import { createHash } from 'node:crypto';

export type CanonicalizeErrorCode =
  | 'canonicalize.undefined_value'
  | 'canonicalize.function_value'
  | 'canonicalize.non_finite_number';

export class CanonicalizeError extends Error {
  public readonly code: CanonicalizeErrorCode;
  constructor(code: CanonicalizeErrorCode, message: string) {
    super(message);
    this.name = 'CanonicalizeError';
    this.code = code;
  }
}

function normalize(value: unknown, path = '$'): unknown {
  if (value === null) return null;

  const type = typeof value;

  if (type === 'undefined') {
    throw new CanonicalizeError(
      'canonicalize.undefined_value',
      `undefined is not serializable (at ${path})`
    );
  }

  if (type === 'function') {
    throw new CanonicalizeError(
      'canonicalize.function_value',
      `functions are not serializable (at ${path})`
    );
  }

  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizeError(
        'canonicalize.non_finite_number',
        `non-finite number ${String(n)} is not serializable (at ${path})`
      );
    }
    return n;
  }

  if (type === 'bigint') {
    return (value as bigint).toString();
  }

  if (type === 'string' || type === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, idx) => normalize(item, `${path}[${idx}]`));
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = normalize(obj[key], `${path}.${key}`);
    }
    return out;
  }

  return value;
}

/**
 * Produce a canonical JSON string for `value`.
 *
 * Two calls with semantically equivalent input produce byte-identical output.
 */
export function canonicalizeJSON(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/**
 * Produce the 32-byte SHA-256 digest of the canonical JSON form of `value`.
 *
 * Invariant: `targetRefHash(obj)` === `targetRefHash(canonicalizeJSON(obj))`.
 */
export function targetRefHash(value: unknown): Buffer {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      const canonicalJson = canonicalizeJSON(parsed);
      if (canonicalJson === value) {
        return targetRefHashCanonicalJSON(value);
      }
    } catch {
      // Raw strings are canonicalized below.
    }
  }

  const json = canonicalizeJSON(value);
  return targetRefHashCanonicalJSON(json);
}

export function targetRefHashCanonicalJSON(canonicalJson: string): Buffer {
  const json = canonicalJson;
  return createHash('sha256').update(json, 'utf8').digest();
}
