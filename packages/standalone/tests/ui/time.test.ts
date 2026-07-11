import { describe, expect, it } from 'vitest';
import { formatRelativeTime, getFreshnessClass } from '../../ui/src/lib/time';

describe('formatRelativeTime', () => {
  const now = 10_000_000;

  it('returns just now for future and sub-minute timestamps', () => {
    expect(formatRelativeTime(now, now + 60_000)).toBe('just now');
    expect(formatRelativeTime(now, now - 59_999)).toBe('just now');
  });

  it('formats elapsed whole minutes', () => {
    expect(formatRelativeTime(now, now - 60_000)).toBe('1m ago');
    expect(formatRelativeTime(now, now - 59 * 60_000)).toBe('59m ago');
  });

  it('formats elapsed whole hours and days', () => {
    expect(formatRelativeTime(now, now - 2 * 60 * 60_000)).toBe('2h ago');
    expect(formatRelativeTime(now, now - 3 * 24 * 60 * 60_000)).toBe('3d ago');
  });

  it('returns unknown for non-finite timestamps', () => {
    expect(formatRelativeTime(now, Number.NaN)).toBe('unknown');
    expect(formatRelativeTime(now, Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('getFreshnessClass', () => {
  const now = 24 * 60 * 60_000;

  it('uses the fresh style until one hour old', () => {
    expect(getFreshnessClass(now, now - (60 * 60_000 - 1))).toBe('bg-agent-light text-agent');
  });

  it('uses the neutral style from one through six hours old', () => {
    expect(getFreshnessClass(now, now - 60 * 60_000)).toBe(
      'bg-surface-secondary text-text-tertiary'
    );
    expect(getFreshnessClass(now, now - 6 * 60 * 60_000)).toBe(
      'bg-surface-secondary text-text-tertiary'
    );
  });

  it('uses the warning style after six hours', () => {
    expect(getFreshnessClass(now, now - (6 * 60 * 60_000 + 1))).toBe(
      'bg-warning-soft text-warning-text'
    );
  });

  it('uses the neutral style for non-finite timestamps', () => {
    expect(getFreshnessClass(now, Number.NaN)).toBe('bg-surface-secondary text-text-tertiary');
    expect(getFreshnessClass(now, Number.NEGATIVE_INFINITY)).toBe(
      'bg-surface-secondary text-text-tertiary'
    );
  });
});
