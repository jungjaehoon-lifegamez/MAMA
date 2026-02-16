import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getErrorMessage,
  formatReasoning,
  truncateText,
  isRecord,
  getStringField,
  isRecentCheckpoint,
} from '../utils';

describe('getErrorMessage', () => {
  it('should extract message from Error instance', () => {
    const err = new Error('test error');
    expect(getErrorMessage(err)).toBe('test error');
  });

  it('should return string directly', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('should JSON.stringify objects', () => {
    expect(getErrorMessage({ code: 500 })).toBe('{"code":500}');
  });

  it('should handle null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('should handle undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('should handle circular references gracefully', () => {
    const circular = {};
    circular.self = circular;
    // Should fall back to String() when JSON.stringify fails
    expect(typeof getErrorMessage(circular)).toBe('string');
  });
});

describe('formatReasoning', () => {
  it('should return empty string for empty input', () => {
    expect(formatReasoning('')).toBe('');
  });

  it('should return text as-is if shorter than maxLen', () => {
    expect(formatReasoning('short text', 80)).toBe('short text');
  });

  it('should truncate text longer than maxLen', () => {
    const longText = 'a'.repeat(100);
    const result = formatReasoning(longText, 80);
    expect(result).toHaveLength(83); // 80 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('should extract builds_on link', () => {
    const reasoning =
      'This decision builds_on: prev_decision_123 and more text here to exceed limit';
    const result = formatReasoning(reasoning, 30);
    expect(result).toContain('builds_on: prev_decision_123');
  });

  it('should extract debates link', () => {
    const reasoning =
      'This debates: other_idea and provides alternative approach with more context';
    const result = formatReasoning(reasoning, 20);
    expect(result).toContain('debates: other_idea');
  });

  it('should extract synthesizes link with array', () => {
    const reasoning =
      'This synthesizes: [idea_1, idea_2] combining multiple approaches for better results';
    const result = formatReasoning(reasoning, 20);
    expect(result).toContain('synthesizes: [idea_1, idea_2]');
  });

  it('should not over-match and capture trailing prose in link extraction', () => {
    // When text is short enough, no link extraction needed (already in truncated)
    const reasoning = 'builds_on: base_idea and then we added more features';
    const result = formatReasoning(reasoning, 200);
    // Full text returned as-is when under maxLen
    expect(result).toBe(reasoning);

    // Test link extraction when truncated - link should only contain ID
    const longReasoning =
      'Some long preamble text that will be truncated. builds_on: base_idea and then more text';
    const truncatedResult = formatReasoning(longReasoning, 30);
    // The extracted link should only be "builds_on: base_idea", not including "and then..."
    expect(truncatedResult).toContain('🔗 builds_on: base_idea');
    expect(truncatedResult).not.toMatch(/🔗.*and then/);
  });
});

describe('truncateText', () => {
  it('should return text as-is if within limit', () => {
    expect(truncateText('short', 10)).toBe('short');
  });

  it('should truncate and add ellipsis if over limit', () => {
    expect(truncateText('hello world', 5)).toBe('hello...');
  });

  it('should handle exact length', () => {
    expect(truncateText('exact', 5)).toBe('exact');
  });
});

describe('isRecord', () => {
  it('should return true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: 'value' })).toBe(true);
  });

  it('should return false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(isRecord('string')).toBe(false);
    expect(isRecord(123)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('should return false for arrays', () => {
    expect(isRecord([])).toBe(false);
  });
});

describe('getStringField', () => {
  it('should return string field value', () => {
    expect(getStringField({ name: 'test' }, 'name')).toBe('test');
  });

  it('should return null for non-string field', () => {
    expect(getStringField({ count: 123 }, 'count')).toBe(null);
  });

  it('should return null for missing field', () => {
    expect(getStringField({}, 'missing')).toBe(null);
  });
});

describe('isRecentCheckpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return true for checkpoint within threshold', () => {
    const now = new Date('2024-01-15T12:00:00Z');
    vi.setSystemTime(now);

    // 1 minute ago
    const recentTimestamp = new Date('2024-01-15T11:59:00Z').toISOString();
    expect(isRecentCheckpoint(recentTimestamp)).toBe(true);
  });

  it('should return false for checkpoint older than threshold', () => {
    const now = new Date('2024-01-15T12:00:00Z');
    vi.setSystemTime(now);

    // 10 minutes ago (default threshold is 5 minutes)
    const oldTimestamp = new Date('2024-01-15T11:50:00Z').toISOString();
    expect(isRecentCheckpoint(oldTimestamp)).toBe(false);
  });

  it('should respect custom threshold', () => {
    const now = new Date('2024-01-15T12:00:00Z');
    vi.setSystemTime(now);

    // 3 minutes ago
    const timestamp = new Date('2024-01-15T11:57:00Z').toISOString();

    // With 2-minute threshold, should be false
    expect(isRecentCheckpoint(timestamp, 2 * 60 * 1000)).toBe(false);

    // With 5-minute threshold, should be true
    expect(isRecentCheckpoint(timestamp, 5 * 60 * 1000)).toBe(true);
  });
});
