import { describe, expect, it } from 'vitest';
import {
  createTimeZoneSetting,
  epochAtLocalDateTime,
  calendarValueKind,
  epochForCalendarValue,
  localDateKey,
  localNow,
} from '../../src/runtime/timezone.js';

describe('owner timezone setting', () => {
  it('states the date, weekday and time of an instant where the owner is', () => {
    expect(localNow(Date.parse('2026-10-05T12:18:00Z'), 'Asia/Seoul')).toBe('2026-10-05 Mon 21:18');
    // Past local midnight the date and the weekday both move.
    expect(localNow(Date.parse('2026-10-04T15:30:00Z'), 'Asia/Seoul')).toBe('2026-10-05 Mon 00:30');
    expect(localNow(Date.parse('2026-10-04T15:30:00Z'), 'UTC')).toBe('2026-10-04 Sun 15:30');
  });

  it('converts local wall times and reads changes through one holder', () => {
    const setting = createTimeZoneSetting('America/Los_Angeles');
    expect(epochAtLocalDateTime('2026-09-27T00:00:00', setting.get())).toBe(
      Date.parse('2026-09-27T07:00:00Z')
    );
    expect(localDateKey(Date.parse('2026-09-27T06:30:00Z'), setting.get())).toBe('2026-09-26');
    setting.set('Europe/Paris');
    expect(epochAtLocalDateTime('2026-09-27T00:00:00', setting.get())).toBe(
      Date.parse('2026-09-26T22:00:00Z')
    );
  });

  it.each([
    ['2026-09-27', 'date'],
    ['20260927', 'date'],
    ['2026-09-27T12:00:00Z', 'utc'],
    ['2026-09-27T12:00:00.000Z', 'utc'],
    ['20260927T120000Z', 'utc'],
    ['2026-09-27T12:00:00+09:00', 'offset'],
    ['2026-09-27T12:00:00.000+09:00', 'offset'],
    ['20260927T120000+0900', 'offset'],
    ['2026-09-27T12:00:00', 'floating'],
    ['20260927T120000', 'floating'],
  ])('derives the calendar kind from %s', (value, kind) => {
    expect(calendarValueKind(value)).toBe(kind);
  });

  it('reads compact iCal UTC and offset times', () => {
    expect(epochForCalendarValue('20261001T060000Z', undefined, 'Asia/Seoul')).toBe(
      Date.parse('2026-10-01T06:00:00Z')
    );
    expect(epochForCalendarValue('20261001T150000+0900', undefined, 'UTC')).toBe(
      Date.parse('2026-10-01T06:00:00Z')
    );
  });

  it('rejects an unknown calendar value naming the value', () => {
    expect(() => calendarValueKind('next Tuesday')).toThrow('invalid calendar value next Tuesday');
  });
});
