import { describe, expect, it } from 'vitest';

import { CanonicalizeError } from '../../src/canonicalize.js';
import {
  buildCaseFieldTargetRef,
  buildMembershipTargetRef,
  buildWikiSectionTargetRef,
  canonicalTargetRef,
  type CaseTargetRef,
} from '../../src/cases/target-ref.js';

describe('case target ref helpers', () => {
  it('keeps object key order from changing the canonical hash', () => {
    const fromBuilder = canonicalTargetRef(buildCaseFieldTargetRef('status'));
    const reordered = canonicalTargetRef({ field: 'status', kind: 'case_field' } as CaseTargetRef);

    expect(fromBuilder.json).toBe('{"field":"status","kind":"case_field"}');
    expect(fromBuilder.json).toBe(reordered.json);
    expect(fromBuilder.hash.equals(reordered.hash)).toBe(true);
  });

  it('preserves membership source_type and source_id in the canonical hash', () => {
    const ref = canonicalTargetRef(buildMembershipTargetRef('event', 'evt-123'));
    const parsed = JSON.parse(ref.json) as {
      kind: string;
      source_type: string;
      source_id: string;
    };
    const otherSource = canonicalTargetRef(buildMembershipTargetRef('event', 'evt-456'));

    expect(parsed).toEqual({
      kind: 'membership',
      source_type: 'event',
      source_id: 'evt-123',
    });
    expect(ref.hash.equals(otherSource.hash)).toBe(false);
  });

  it('hashes wiki section target refs to a 32-byte Buffer', () => {
    const ref = canonicalTargetRef(buildWikiSectionTargetRef('Current status'));

    expect(ref.json).toBe('{"kind":"wiki_section","section_heading":"Current status"}');
    expect(Buffer.isBuffer(ref.hash)).toBe(true);
    expect(ref.hash.length).toBe(32);
  });

  it('throws canonicalize.undefined_value for undefined target values', () => {
    const invalid = {
      kind: 'wiki_section',
      section_heading: undefined,
    } as unknown as CaseTargetRef;

    expect(() => canonicalTargetRef(invalid)).toThrow(CanonicalizeError);

    try {
      canonicalTargetRef(invalid);
    } catch (error) {
      expect((error as CanonicalizeError).code).toBe('canonicalize.undefined_value');
    }
  });
});
