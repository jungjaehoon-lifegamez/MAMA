import { describe, it, expect } from 'vitest';
import { buildActivitySummaries, type RawFeedItem } from '../../src/api/connector-feed-handler.js';

// ---------------------------------------------------------------------------
// buildActivitySummaries
// ---------------------------------------------------------------------------

describe('buildActivitySummaries', () => {
  it('picks latest item per connector and sorts by timestamp desc', () => {
    const items: RawFeedItem[] = [
      { connector: 'slack', channel: '#general', author: 'kim', content: 'old', timestamp: 1000 },
      { connector: 'slack', channel: '#proj', author: 'park', content: 'new msg', timestamp: 2000 },
      {
        connector: 'calendar',
        channel: 'personal',
        author: 'system',
        content: 'meeting at 14:00',
        timestamp: 1500,
      },
    ];
    const result = buildActivitySummaries(items);
    expect(result).toHaveLength(2);
    expect(result[0].connector).toBe('slack');
    expect(result[0].content).toBe('new msg');
    expect(result[1].connector).toBe('calendar');
  });

  it('returns empty for empty input', () => {
    expect(buildActivitySummaries([])).toEqual([]);
  });

  it('truncates content to 80 chars', () => {
    const items: RawFeedItem[] = [
      {
        connector: 'slack',
        channel: '#c',
        author: 'a',
        content: 'x'.repeat(200),
        timestamp: 1000,
      },
    ];
    const result = buildActivitySummaries(items);
    expect(result[0].content.length).toBeLessThanOrEqual(80);
  });

  it('sets status to active for all items', () => {
    const items: RawFeedItem[] = [
      { connector: 'slack', channel: '#c', author: 'a', content: 'hi', timestamp: 1000 },
      { connector: 'telegram', channel: 'chat', author: 'b', content: 'hey', timestamp: 2000 },
    ];
    const result = buildActivitySummaries(items);
    for (const r of result) {
      expect(r.status).toBe('active');
    }
  });

  it('uses channel from the latest item per connector', () => {
    const items: RawFeedItem[] = [
      { connector: 'slack', channel: '#old-chan', author: 'a', content: 'old', timestamp: 100 },
      { connector: 'slack', channel: '#new-chan', author: 'b', content: 'new', timestamp: 200 },
    ];
    const result = buildActivitySummaries(items);
    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe('#new-chan');
  });

  it('produces ISO timestamp string in output', () => {
    const items: RawFeedItem[] = [
      { connector: 'slack', channel: '#c', author: 'a', content: 'hi', timestamp: 1700000000000 },
    ];
    const result = buildActivitySummaries(items);
    // Should be a valid ISO date string
    expect(() => new Date(result[0].timestamp).toISOString()).not.toThrow();
    expect(result[0].timestamp).toBe(new Date(1700000000000).toISOString());
  });

  it('adds ellipsis when truncating content', () => {
    const items: RawFeedItem[] = [
      {
        connector: 'slack',
        channel: '#c',
        author: 'a',
        content: 'a'.repeat(100),
        timestamp: 1000,
      },
    ];
    const result = buildActivitySummaries(items);
    expect(result[0].content).toMatch(/\.\.\.$/);
    expect(result[0].content.length).toBeLessThanOrEqual(80);
  });

  it('does not add ellipsis for content within 80 chars', () => {
    const items: RawFeedItem[] = [
      { connector: 'slack', channel: '#c', author: 'a', content: 'short msg', timestamp: 1000 },
    ];
    const result = buildActivitySummaries(items);
    expect(result[0].content).toBe('short msg');
  });
});
