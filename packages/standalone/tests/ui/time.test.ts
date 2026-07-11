import { describe, expect, it } from 'vitest';
import { formatDday, formatRelativeTime, getFreshnessClass } from '../../ui/src/lib/time';

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

describe('formatDday', () => {
  const localNoon = new Date(2026, 6, 12, 12).getTime();

  it('returns a dash without a due date and for invalid dates', () => {
    expect(formatDday(localNoon, null)).toBe('-');
    expect(formatDday(localNoon, '2026-02-30')).toBe('-');
    expect(formatDday(localNoon, 'not-a-date')).toBe('-');
  });

  it('formats today, future, and overdue dates', () => {
    expect(formatDday(localNoon, '2026-07-12')).toBe('D-day');
    expect(formatDday(localNoon, '2026-07-15')).toBe('D-3');
    expect(formatDday(localNoon, '2026-07-10')).toBe('D+2');
  });

  it('handles month and year boundaries with UTC calendar arithmetic', () => {
    const yearEnd = new Date(2026, 11, 31, 23, 30).getTime();
    expect(formatDday(yearEnd, '2027-01-01')).toBe('D-1');
    const monthStart = new Date(2026, 7, 1, 0, 30).getTime();
    expect(formatDday(monthStart, '2026-07-31')).toBe('D+1');
  });
});
