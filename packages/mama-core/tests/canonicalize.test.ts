import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { CanonicalizeError, canonicalizeJSON, targetRefHash } from '../src/canonicalize.js';

const cjsRequire = createRequire(import.meta.url);

describe('canonicalizeJSON', () => {
  it('is stable across differently ordered sibling keys', () => {
    const a = canonicalizeJSON({ b: 2, a: 1 });
    const b = canonicalizeJSON({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it('sorts nested object keys recursively', () => {
    const a = canonicalizeJSON({ outer: { z: 1, a: 2 }, alpha: { y: 3, x: 4 } });
    const b = canonicalizeJSON({ alpha: { x: 4, y: 3 }, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"alpha":{"x":4,"y":3},"outer":{"a":2,"z":1}}');
  });

  it('preserves array order (arrays are semantic)', () => {
    expect(canonicalizeJSON(['a', 'b', 'c'])).toBe('["a","b","c"]');
    expect(canonicalizeJSON(['c', 'b', 'a'])).toBe('["c","b","a"]');
    expect(canonicalizeJSON(['a', 'b', 'c'])).not.toBe(canonicalizeJSON(['c', 'b', 'a']));
  });

  it('distinguishes numeric 1 from string "1"', () => {
    expect(canonicalizeJSON({ x: 1 })).toBe('{"x":1}');
    expect(canonicalizeJSON({ x: '1' })).toBe('{"x":"1"}');
    expect(canonicalizeJSON({ x: 1 })).not.toBe(canonicalizeJSON({ x: '1' }));
  });

  it('rejects undefined values with canonicalize.undefined_value', () => {
    expect(() => canonicalizeJSON({ x: undefined })).toThrow(CanonicalizeError);
    try {
      canonicalizeJSON({ x: undefined });
    } catch (err) {
      expect((err as CanonicalizeError).code).toBe('canonicalize.undefined_value');
    }
  });

  it('rejects function values with canonicalize.function_value', () => {
    const fn = (): number => 42;
    expect(() => canonicalizeJSON({ x: fn })).toThrow(CanonicalizeError);
    try {
      canonicalizeJSON({ x: fn });
    } catch (err) {
      expect((err as CanonicalizeError).code).toBe('canonicalize.function_value');
    }
  });

  it('rejects non-finite numbers with canonicalize.non_finite_number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalizeJSON({ x: bad })).toThrow(CanonicalizeError);
      try {
        canonicalizeJSON({ x: bad });
      } catch (err) {
        expect((err as CanonicalizeError).code).toBe('canonicalize.non_finite_number');
      }
    }
  });

  it('handles nested arrays of objects', () => {
    const s = canonicalizeJSON({
      list: [
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ],
    });
    expect(s).toBe('{"list":[{"a":1,"b":2},{"c":3,"d":4}]}');
  });
});

describe('targetRefHash', () => {
  it('returns a 32-byte Buffer (SHA-256 digest)', () => {
    const h = targetRefHash({ a: 1 });
    expect(Buffer.isBuffer(h)).toBe(true);
    expect(h.length).toBe(32);
  });

  it('produces identical hashes for semantically equivalent input (different key order)', () => {
    const h1 = targetRefHash({ b: 2, a: 1 });
    const h2 = targetRefHash({ a: 1, b: 2 });
    expect(h1.equals(h2)).toBe(true);
  });

  it('composition: targetRefHash(obj) === targetRefHash(canonicalizeJSON(obj))', () => {
    const x = { z: [1, 2, 3], alpha: { inner: true }, beta: 'text' };
    const direct = targetRefHash(x);
    const composed = targetRefHash(canonicalizeJSON(x));
    expect(direct.equals(composed)).toBe(true);
  });

  it('hashes semantically distinct input to distinct digests', () => {
    const h1 = targetRefHash({ x: 1 });
    const h2 = targetRefHash({ x: '1' });
    expect(h1.equals(h2)).toBe(false);
  });
});

describe('CJS require interop via createRequire', () => {
  // Resolves against dist/ — requires `pnpm --filter @jungjaehoon/mama-core build`
  // to have run before this test. Without dist, the require throws and this
  // test surfaces the export-map break that ESM-only tests would miss.
  it('imports canonicalizeJSON and targetRefHash through the CJS subpath export', () => {
    const cjs = cjsRequire('@jungjaehoon/mama-core/canonicalize') as {
      canonicalizeJSON: typeof canonicalizeJSON;
      targetRefHash: typeof targetRefHash;
    };
    expect(typeof cjs.canonicalizeJSON).toBe('function');
    expect(typeof cjs.targetRefHash).toBe('function');

    const obj = { b: 2, a: 1 };
    expect(cjs.canonicalizeJSON(obj)).toBe(canonicalizeJSON(obj));
    expect(cjs.targetRefHash(obj).equals(targetRefHash(obj))).toBe(true);
  });
});
