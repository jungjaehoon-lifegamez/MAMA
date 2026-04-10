import { describe, it, expect } from 'vitest';
import {
  groupByMonth,
  getCompilationStats,
} from '../../src/connectors/kagemusha/history-compiler.js';

describe('Kagemusha history compiler', () => {
  const makeItem = (date: string, content: string) => ({
    sourceId: content,
    timestamp: new Date(date),
    content,
    source: 'kagemusha',
    channel: 'general',
    author: 'user',
    type: 'message' as const,
  });

  it('groups items by year-month', () => {
    const items = [
      makeItem('2025-11-15', 'Nov 1'),
      makeItem('2025-11-20', 'Nov 2'),
      makeItem('2025-12-05', 'Dec 1'),
    ];
    const grouped = groupByMonth(items);
    expect(grouped.get('2025-11')?.length).toBe(2);
    expect(grouped.get('2025-12')?.length).toBe(1);
  });

  it('returns empty map for empty input', () => {
    const grouped = groupByMonth([]);
    expect(grouped.size).toBe(0);
  });

  it('calculates stats correctly', () => {
    const items = [
      makeItem('2025-11-15', 'a'),
      makeItem('2025-11-20', 'b'),
      makeItem('2025-12-05', 'c'),
    ];
    const stats = getCompilationStats(groupByMonth(items));
    expect(stats.months).toEqual(['2025-11', '2025-12']);
    expect(stats.totalItems).toBe(3);
    expect(stats.perMonth['2025-11']).toBe(2);
  });
});
