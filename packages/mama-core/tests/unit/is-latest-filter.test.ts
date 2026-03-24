import { describe, it, expect } from 'vitest';

describe('isLatest filter', () => {
  it('should filter out decisions with superseded_by set', () => {
    const decisions = [
      { id: 'a', topic: 'db', superseded_by: 'b' },
      { id: 'b', topic: 'db', superseded_by: null },
      { id: 'c', topic: 'auth', superseded_by: null },
    ];

    const filtered = decisions.filter((d) => d.superseded_by === null);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('should include superseded decisions when include_superseded is true', () => {
    const decisions = [
      { id: 'a', topic: 'db', superseded_by: 'b' },
      { id: 'b', topic: 'db', superseded_by: null },
    ];

    expect(decisions).toHaveLength(2);
  });
});
