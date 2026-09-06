/**
 * Wiki daily-continuity host planner: owner-date + range computation, the
 * source watermark that excludes agent notices, and the date/watermark skip
 * gate. Pure functions; no DB, no clock, no I/O.
 */
import { describe, it, expect } from 'vitest';

import {
  ownerDateForInstant,
  ownerDayRange,
  parseStrictOwnerDate,
  composeWikiSourceWatermark,
  evaluateWikiContinuity,
  WIKI_WATERMARK_MAX_LENGTH,
  type WikiBaseline,
  type WikiContinuityInput,
} from '../../src/operator/wiki-continuity.js';

const HOUR = 60 * 60 * 1000;

// 2026-09-05T02:00Z = 11:00 KST -> owner date 2026-09-05, inside the owner day
// [2026-09-04T15:00Z, 2026-09-05T15:00Z).
const NOW = Date.parse('2026-09-05T02:00:00Z');
const SEOUL_DAY = {
  start: Date.parse('2026-09-04T15:00:00Z'),
  end: Date.parse('2026-09-05T15:00:00Z'),
};

function baseInput(overrides: Partial<WikiContinuityInput> = {}): WikiContinuityInput {
  return {
    nowMs: NOW,
    timeZone: 'Asia/Seoul',
    connectors: ['slack', 'chatwork'],
    trigger: 'hourly',
    readSourceWatermark: () => 'w1:c:slack=10|t:hash|m:99/99',
    readBaseline: () => null,
    ...overrides,
  };
}

describe('owner-date computation', () => {
  it('derives the owner-local calendar date in Asia/Seoul (no DST)', () => {
    // 2026-09-04T20:00Z is 2026-09-05T05:00 KST.
    expect(ownerDateForInstant(Date.parse('2026-09-04T20:00:00Z'), 'Asia/Seoul')).toBe(
      '2026-09-05'
    );
  });

  it('derives the owner-local calendar date in a DST zone', () => {
    // Same instant is still 2026-09-04 in New York (EDT, UTC-4 -> 16:00).
    expect(ownerDateForInstant(Date.parse('2026-09-04T20:00:00Z'), 'America/New_York')).toBe(
      '2026-09-04'
    );
  });

  it('spans a fixed-offset owner day as exactly 24h', () => {
    const { start_ms, end_ms } = ownerDayRange('2026-09-05', 'Asia/Seoul');
    expect(new Date(start_ms).toISOString()).toBe('2026-09-04T15:00:00.000Z');
    expect(end_ms - start_ms).toBe(24 * HOUR);
  });

  it('spans a DST spring-forward owner day as 23h', () => {
    // 2026-03-08 New York loses an hour (02:00 -> 03:00 EDT).
    const { start_ms, end_ms } = ownerDayRange('2026-03-08', 'America/New_York');
    expect(end_ms - start_ms).toBe(23 * HOUR);
  });

  it('spans a DST fall-back owner day as 25h', () => {
    // 2026-11-01 New York gains an hour (02:00 EDT -> 01:00 EST).
    const { start_ms, end_ms } = ownerDayRange('2026-11-01', 'America/New_York');
    expect(new Date(start_ms).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(end_ms - start_ms).toBe(25 * HOUR);
  });

  it('rejects malformed owner dates and accepts a valid one', () => {
    expect(() => parseStrictOwnerDate('2026-13-40')).toThrow();
    expect(() => parseStrictOwnerDate('2026-9-5')).toThrow();
    expect(() => parseStrictOwnerDate('not-a-date')).toThrow();
    expect(parseStrictOwnerDate('2026-09-05')).toBe('2026-09-05');
  });
});

describe('wiki source watermark', () => {
  it('changes when any term moves', () => {
    const a = composeWikiSourceWatermark(['c:slack=10', 't:h1', 'm:1/1']);
    const b = composeWikiSourceWatermark(['c:slack=11', 't:h1', 'm:1/1']);
    const c = composeWikiSourceWatermark(['c:slack=10', 't:h2', 'm:1/1']);
    const d = composeWikiSourceWatermark(['c:slack=10', 't:h1', 'm:2/1']);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('stays within the payload field bound by digesting oversized inputs', () => {
    const huge = composeWikiSourceWatermark([`c:${'x'.repeat(4000)}`]);
    expect(huge.length).toBeLessThanOrEqual(WIKI_WATERMARK_MAX_LENGTH);
    expect(huge.startsWith('w1h:')).toBe(true);
  });
});

describe('evaluateWikiContinuity', () => {
  it('a current-day no-baseline run covers the day start through NOW (not the future day end)', () => {
    const decision = evaluateWikiContinuity(baseInput({ readBaseline: () => null }));
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('no-baseline');
    expect(decision.payload).not.toBeNull();
    // end_ms is exactly now, never the next-midnight day end.
    expect(decision.payload?.range).toEqual({ start_ms: SEOUL_DAY.start, end_ms: NOW });
    expect(decision.payload!.range.end_ms).toBeLessThan(SEOUL_DAY.end);
    expect(decision.payload?.ownerDate).toBe('2026-09-05');
    expect(decision.payload?.connectors).toEqual(['slack', 'chatwork']);
    expect(decision.payload?.sourceWatermark).toBe('w1:c:slack=10|t:hash|m:99/99');
    expect(decision.payload?.events).toEqual(['hourly']);
  });

  it('treats a legacy baseline (null fields) as no baseline', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        readBaseline: (): WikiBaseline => ({
          ownerDate: null,
          sourceWatermark: null,
          coveredThroughMs: null,
          completedAt: Date.parse('2026-09-05T01:00:00Z'),
        }),
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('no-baseline');
    // A legacy baseline cannot move the range start off the day boundary.
    expect(decision.payload?.range.start_ms).toBe(SEOUL_DAY.start);
  });

  it('the T1..T2 gap cannot disappear: next same-day start is the prior coveredThroughMs, not completion time', () => {
    // Prior run snapshotted input through T1, then finished at T2. Events landing
    // in (T1, T2] must still be covered by the next run starting at T1.
    const T1 = Date.parse('2026-09-04T16:00:00Z');
    const T2 = Date.parse('2026-09-04T18:00:00Z');
    const decision = evaluateWikiContinuity(
      baseInput({
        // T3 = NOW (2026-09-05T02:00Z), same owner day, after T2.
        readSourceWatermark: () => 'w1:moved',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-05',
          sourceWatermark: 'w1:old',
          coveredThroughMs: T1,
          completedAt: T2,
        }),
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('delta');
    expect(decision.payload?.range.start_ms).toBe(T1);
    // Never the completion time - that is exactly the lost-events bug.
    expect(decision.payload?.range.start_ms).not.toBe(T2);
    expect(decision.payload?.range.end_ms).toBe(NOW);
  });

  it('never derives an invalid range from an out-of-day coveredThrough', () => {
    // coveredThroughMs is BEFORE the owner day started (a stale/other-day value).
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => 'w1:moved',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-05',
          sourceWatermark: 'w1:old',
          coveredThroughMs: Date.parse('2026-09-03T10:00:00Z'),
          completedAt: Date.parse('2026-09-05T00:00:00Z'),
        }),
      })
    );
    expect(decision.payload?.range.start_ms).toBe(SEOUL_DAY.start);
    expect(decision.payload!.range.start_ms).toBeLessThanOrEqual(decision.payload!.range.end_ms);
  });

  it('does not skip when a same-watermark baseline has a null coverage boundary', () => {
    // A malformed typed baseline (null coveredThroughMs) with a matching
    // watermark must NOT authorize a no-change skip: its coverage point is
    // unusable, so the run enqueues from day start.
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => 'w1:same',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-05',
          sourceWatermark: 'w1:same',
          coveredThroughMs: null,
          completedAt: Date.parse('2026-09-05T01:00:00Z'),
        }),
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('no-baseline');
    expect(decision.payload?.range.start_ms).toBe(SEOUL_DAY.start);
  });

  it('does not skip when a same-watermark baseline coverage boundary is beyond the range end', () => {
    // A future coveredThroughMs (past the range end) is unusable; a matching
    // watermark cannot license a skip.
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => 'w1:same',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-05',
          sourceWatermark: 'w1:same',
          coveredThroughMs: Date.parse('2026-09-05T10:00:00Z'), // after NOW (02:00Z)
          completedAt: Date.parse('2026-09-05T01:00:00Z'),
        }),
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('no-baseline');
    expect(decision.payload?.range.start_ms).toBe(SEOUL_DAY.start);
  });

  it('gives a new owner date one run even when sources are quiet', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => 'w1:same',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-04',
          sourceWatermark: 'w1:same',
          coveredThroughMs: Date.parse('2026-09-04T20:00:00Z'),
          completedAt: Date.parse('2026-09-04T20:00:00Z'),
        }),
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('new-owner-date');
    // A previous day's coveredThrough cannot bleed into today's range.
    expect(decision.payload?.range.start_ms).toBe(SEOUL_DAY.start);
  });

  it('skips a quiet same-day tick with an unchanged watermark', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => 'w1:same',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-05',
          sourceWatermark: 'w1:same',
          coveredThroughMs: Date.parse('2026-09-05T01:00:00Z'),
          completedAt: Date.parse('2026-09-05T01:00:00Z'),
        }),
      })
    );
    expect(decision.enqueue).toBe(false);
    expect(decision.reason).toBe('no-change');
    expect(decision.payload).toBeNull();
  });

  it('enqueues when the connector/task/memory watermark moves', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => 'w1:new',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-05',
          sourceWatermark: 'w1:old',
          coveredThroughMs: Date.parse('2026-09-05T01:00:00Z'),
          completedAt: Date.parse('2026-09-05T01:00:00Z'),
        }),
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('delta');
    expect(decision.payload?.range.start_ms).toBe(Date.parse('2026-09-05T01:00:00Z'));
    expect(decision.payload?.range.end_ms).toBe(NOW);
  });

  it('lets a forced request bypass the same-day skip', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        forced: true,
        readSourceWatermark: () => 'w1:same',
        readBaseline: (): WikiBaseline => ({
          ownerDate: '2026-09-05',
          sourceWatermark: 'w1:same',
          coveredThroughMs: Date.parse('2026-09-05T01:00:00Z'),
          completedAt: Date.parse('2026-09-05T01:00:00Z'),
        }),
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('forced');
    expect(decision.payload).not.toBeNull();
  });

  it('enqueues a safe day-start..now range when the signal is unavailable', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => {
          throw new Error('index unavailable');
        },
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('signal-unavailable');
    expect(decision.warning).toContain('index unavailable');
    expect(decision.payload?.range).toEqual({ start_ms: SEOUL_DAY.start, end_ms: NOW });
    expect(decision.payload?.sourceWatermark).toBeNull();
  });

  it('backfills a strict past owner date with that full day range (end is the target day end)', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        requestedOwnerDate: '2026-09-03',
        forced: true,
      })
    );
    expect(decision.enqueue).toBe(true);
    expect(decision.payload?.ownerDate).toBe('2026-09-03');
    const { start_ms, end_ms } = ownerDayRange('2026-09-03', 'Asia/Seoul');
    expect(decision.payload?.range).toEqual({ start_ms, end_ms });
  });

  it('rejects a malformed manual owner date', () => {
    expect(() =>
      evaluateWikiContinuity(baseInput({ requestedOwnerDate: '2026-9-3', forced: true }))
    ).toThrow();
  });

  it('rejects a future requested owner date', () => {
    // Current owner date is 2026-09-05; a later date cannot be backfilled.
    expect(() =>
      evaluateWikiContinuity(baseInput({ requestedOwnerDate: '2026-09-06', forced: true }))
    ).toThrow(/future/i);
  });

  it('carries a deterministic noUpdateScope from the source snapshot, not batchId', () => {
    const a = evaluateWikiContinuity(baseInput({ readSourceWatermark: () => 'w1:same' }));
    // Same owner date + watermark, different batchId (later nowMs / trigger) ->
    // the SAME scope: it is derived from the snapshot, not the batch.
    const b = evaluateWikiContinuity(
      baseInput({ nowMs: NOW + 5000, trigger: 'boot', readSourceWatermark: () => 'w1:same' })
    );
    expect(a.payload?.noUpdateScope).toMatch(/^wiki:2026-09-05:/);
    expect(a.payload?.noUpdateScope).toBe(b.payload?.noUpdateScope);
    // No raw source terms, and not derived from batchId.
    expect(a.payload?.noUpdateScope).not.toContain('w1:same');
    expect(a.payload?.noUpdateScope).not.toContain(String(a.payload?.batchId));
    // A different snapshot yields a different scope.
    const c = evaluateWikiContinuity(baseInput({ readSourceWatermark: () => 'w1:other' }));
    expect(c.payload?.noUpdateScope).not.toBe(a.payload?.noUpdateScope);
  });

  it('gives a signal-unavailable run an na noUpdateScope with no raw terms', () => {
    const decision = evaluateWikiContinuity(
      baseInput({
        readSourceWatermark: () => {
          throw new Error('index unavailable');
        },
      })
    );
    expect(decision.payload?.noUpdateScope).toBe('wiki:2026-09-05:na');
  });

  it('carries a canonical RFC3339 taskUpdatedSince equal to range.start_ms', () => {
    // The real task_list facade rejects a numeric updated_since and requires an
    // RFC 3339 string, so the host derives it from range.start_ms.
    const decision = evaluateWikiContinuity(baseInput({ readBaseline: () => null }));
    const start = decision.payload!.range.start_ms;
    expect(decision.payload?.taskUpdatedSince).toBe(new Date(start).toISOString());
    expect(Date.parse(decision.payload!.taskUpdatedSince)).toBe(start);
    expect(decision.payload?.taskUpdatedSince).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(decision.payload?.taskUpdatedBefore).toBe(
      new Date(decision.payload!.range.end_ms).toISOString()
    );
  });
});
