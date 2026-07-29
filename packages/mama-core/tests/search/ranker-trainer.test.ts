import { describe, expect, it } from 'vitest';

import { RANKER_QUALITY_FIXTURES } from '../../src/search/ranker-trainer.js';

// What is left of this file now the trainer has gone: the fixtures are still exported and still
// shaped like a ranking benchmark, and this holds the property that made them usable as one.
// The database setup went with the trainer - a constant needs no schema.
describe('ranker quality fixtures', () => {
  it('uses varied fixture ordering so ties cannot rely on the same first item', () => {
    const leadingRelevances = RANKER_QUALITY_FIXTURES.map(
      (fixture) => fixture.candidates[0]?.relevance
    );

    expect(leadingRelevances).toContain(0);
    expect(new Set(leadingRelevances).size).toBeGreaterThan(1);
  });
});
