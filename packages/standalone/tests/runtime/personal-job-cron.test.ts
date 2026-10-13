import { describe, expect, it } from 'vitest';
import {
  cronOccurrences,
  latestCronOccurrence,
  validateJobCron,
} from '../../src/runtime/personal-job-cron.js';
const at = (iso: string) => Date.parse(iso);
describe('numeric five-field cron', () => {
  it.each([
    ['0 8 * * *', '2026-01-01T08:00:00Z'],
    ['15,45 8-10/2 * * *', '2026-01-01T08:15:00Z'],
    ['0 */6 * * *', '2026-01-01T06:00:00Z'],
    ['0 8 2 1 *', '2026-01-02T08:00:00Z'],
    ['0 8 * * 0,7', '2026-01-04T08:00:00Z'],
    ['0 8 2 * 1', '2026-01-02T08:00:00Z'],
    ['0 8 * * 1-5', '2026-01-01T08:00:00Z'],
    ['0 0 29 2 *', '2028-02-29T00:00:00Z'],
    ['0 9 */2 * 1-5', '2026-01-01T09:00:00Z'],
  ])('matches %s including lists/ranges/steps and DOM/DOW OR', (cron, first) => {
    expect(cronOccurrences(cron, 'UTC', at('2026-01-01T00:00:00Z'), 1)).toEqual([at(first)]);
  });
  it.each([
    '',
    '* * * *',
    '* * * * * *',
    '0 25 * * *',
    '0 0 0 * *',
    '0 0 * 13 *',
    '0 0 * * 8',
    '*/0 * * * *',
    '0 8-2 * * *',
    'a * * * *',
    '0 0 30 2 *',
  ])('rejects invalid or impossible %s', (cron) => {
    expect(() => validateJobCron(cron, 'UTC', at('2026-01-01T00:00:00Z'))).toThrow(/cron/i);
  });
  it('checks future spacings and accepts exactly 60 minutes', () => {
    expect(() => validateJobCron('0,30 * * * *', 'UTC', at('2026-01-01T00:00:00Z'))).toThrow(
      /60 minutes/
    );
    expect(() => validateJobCron('0 * * * *', 'UTC', at('2026-01-01T00:00:00Z'))).not.toThrow();
  });
  it('runs a gap wall time at the first instant after the gap and a fold wall time only at its first instant', () => {
    expect(
      cronOccurrences('30 2 * * *', 'America/New_York', at('2026-03-08T00:00:00Z'), 1)
    ).toEqual([at('2026-03-08T07:00:00Z')]);
    expect(
      cronOccurrences('30 1 * * *', 'America/New_York', at('2026-11-01T00:00:00Z'), 2)
    ).toEqual([at('2026-11-01T05:30:00Z'), at('2026-11-02T06:30:00Z')]);
    expect(
      cronOccurrences('30 1 * * *', 'Australia/Lord_Howe', at('2026-04-04T12:00:00Z'), 2)
    ).toEqual([at('2026-04-04T14:30:00Z'), at('2026-04-05T15:00:00Z')]);
    expect(
      cronOccurrences('45 1 * * *', 'Australia/Lord_Howe', at('2026-04-04T12:00:00Z'), 2)
    ).toEqual([at('2026-04-04T14:45:00Z'), at('2026-04-05T15:15:00Z')]);
    for (const cron of ['30 1 * * *', '45 1 * * *'])
      expect(() =>
        validateJobCron(cron, 'Australia/Lord_Howe', at('2026-06-01T00:00:00Z'))
      ).not.toThrow();
  });
  it('covers future half-hour DST transitions even when saved in June', () => {
    expect(() =>
      validateJobCron('45 1,2 * * *', 'Australia/Lord_Howe', at('2026-06-01T00:00:00Z'))
    ).toThrow(/60 minutes/);
    // 02:15 is shifted to 03:00 at the spring gap, only 15 minutes before 03:15.
    expect(() =>
      validateJobCron('15 2,3 * * *', 'America/New_York', at('2026-06-01T00:00:00Z'))
    ).toThrow(/60 minutes/);
    expect(() =>
      validateJobCron('30 1,2 * * *', 'Australia/Lord_Howe', at('2026-06-01T00:00:00Z'))
    ).toThrow(/60 minutes/);
  });
  it('treats a leading wildcard step as unrestricted for the DOM/DOW rule', () => {
    expect(cronOccurrences('0 9 */2 * 1-5', 'UTC', at('2026-01-01T10:00:00Z'), 3)).toEqual(
      ['2026-01-05T09:00:00Z', '2026-01-07T09:00:00Z', '2026-01-09T09:00:00Z'].map(at)
    );
  });
  it('uses the named zone and takes only the latest missed occurrence', () => {
    expect(cronOccurrences('0 8 * * *', 'Asia/Seoul', at('2026-01-01T00:00:00Z'), 1)).toEqual([
      at('2026-01-01T23:00:00Z'),
    ]);
    expect(
      latestCronOccurrence(
        '0 * * * *',
        'UTC',
        at('2026-01-01T03:10:00Z'),
        at('2026-01-01T00:10:00Z')
      )
    ).toBe(at('2026-01-01T03:00:00Z'));
  });
});
