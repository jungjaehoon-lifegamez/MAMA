import { describe, expect, it } from 'vitest';

import { normalizeSearchQualityOptions } from '../../src/search/search-quality.js';

describe('Story Context A1: search quality options', () => {
  it('keeps recall defaults backward compatible', () => {
    expect(normalizeSearchQualityOptions({})).toMatchObject({
      strictness: 'recall',
      threshold: 0.3,
      includeRelated: true,
      minLexicalSupport: false,
      diagnostics: false,
    });
  });

  it('treats strict true as strictness strict', () => {
    expect(normalizeSearchQualityOptions({ strict: true })).toMatchObject({
      strictness: 'strict',
      threshold: 0.6,
      includeRelated: false,
      minLexicalSupport: true,
    });
  });

  it('does not override an explicit threshold', () => {
    expect(normalizeSearchQualityOptions({ strict: true, threshold: 0.42 }).threshold).toBe(0.42);
  });
});
