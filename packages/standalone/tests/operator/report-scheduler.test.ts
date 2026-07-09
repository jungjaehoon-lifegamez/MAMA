/**
 * Unit tests for ReportScheduler (M2-T0) - the scheduled full-report cadence.
 * Pure local-hour decision + persisted last-fired key (restart-safe, no double-send).
 * No agent, no loop. Ports the Kagemusha tickScheduledReports mechanism (LOCAL hours here).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReportScheduler,
  FileReportScheduleStore,
  hourKeyLocal,
  parseReportHours,
  type ReportScheduleStore,
} from '../../src/operator/report-scheduler.js';

function memStore(initial: string | null = null): ReportScheduleStore & { saved: string[] } {
  let key = initial;
  const saved: string[] = [];
  return { saved, load: () => key, save: (k: string) => { key = k; saved.push(k); } };
}

describe('parseReportHours', () => {
  it('parses, dedupes, sorts, clamps to [0,23]', () => {
    expect(parseReportHours('8,13,18')).toEqual([8, 13, 18]);
    expect(parseReportHours('18, 8, 8, 13')).toEqual([8, 13, 18]);
    expect(parseReportHours('25,-1,7,foo,,12')).toEqual([7, 12]);
  });
  it('empty or garbage -> [] (feature off)', () => {
    expect(parseReportHours('')).toEqual([]);
    expect(parseReportHours('   ')).toEqual([]);
    expect(parseReportHours('nope')).toEqual([]);
  });
});

describe('hourKeyLocal', () => {
  it('buckets by local YYYY-MM-DD:HH; same hour -> same key', () => {
    const a = new Date(2026, 6, 9, 8, 5, 0);
    const b = new Date(2026, 6, 9, 8, 59, 59);
    const c = new Date(2026, 6, 9, 9, 0, 0);
    expect(hourKeyLocal(a)).toBe('2026-07-09:08');
    expect(hourKeyLocal(a)).toBe(hourKeyLocal(b));
    expect(hourKeyLocal(c)).toBe('2026-07-09:09');
  });
});

describe('ReportScheduler.shouldFire', () => {
  it('fires on a configured hour once, then suppresses the rest of that hour', () => {
    const s = new ReportScheduler([8, 13, 18], memStore());
    const first = s.shouldFire(new Date(2026, 6, 9, 8, 5));
    expect(first.fire).toBe(true);
    expect(first.hourKey).toBe('2026-07-09:08');
    s.markFired(first.hourKey);
    expect(s.shouldFire(new Date(2026, 6, 9, 8, 45)).fire).toBe(false);
  });
  it('does not fire outside configured hours', () => {
    const s = new ReportScheduler([8, 13, 18], memStore());
    expect(s.shouldFire(new Date(2026, 6, 9, 10, 0)).fire).toBe(false);
  });
  it('fires again at the next configured hour (new key)', () => {
    const s = new ReportScheduler([8, 13], memStore());
    s.markFired(s.shouldFire(new Date(2026, 6, 9, 8, 5)).hourKey);
    expect(s.shouldFire(new Date(2026, 6, 9, 13, 2)).fire).toBe(true);
  });
  it('restart does not double-send: a persisted key for the current hour suppresses', () => {
    const s = new ReportScheduler([8], memStore('2026-07-09:08'));
    expect(s.shouldFire(new Date(2026, 6, 9, 8, 30)).fire).toBe(false);
  });
  it('a configured hour that fully elapsed while down is SKIPPED, not fired late (no catch-up)', () => {
    // Down across the whole 08:00-08:59 window; back at 09:30 and 9 is not a configured hour.
    const s = new ReportScheduler([8], memStore('2026-07-08:08'));
    expect(s.shouldFire(new Date(2026, 6, 9, 9, 30)).fire).toBe(false);
  });
  it('fires late within a still-current configured hour after downtime', () => {
    // Down since before 08:00, back at 08:45: the 08 hour is still current -> fire now.
    const s = new ReportScheduler([8], memStore('2026-07-08:08'));
    expect(s.shouldFire(new Date(2026, 6, 9, 8, 45)).fire).toBe(true);
  });
  it('empty hours -> never fires', () => {
    const s = new ReportScheduler([], memStore());
    expect(s.shouldFire(new Date(2026, 6, 9, 8, 0)).fire).toBe(false);
  });
});

describe('FileReportScheduleStore', () => {
  let tmp: string;
  let path: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'report-sched-')); path = join(tmp, 'state.json'); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('load() -> null when absent; save/load round-trips; survives a fresh instance (restart)', () => {
    const store = new FileReportScheduleStore(path);
    expect(store.load()).toBeNull();
    store.save('2026-07-09:08');
    expect(existsSync(path)).toBe(true);
    expect(store.load()).toBe('2026-07-09:08');
    expect(new FileReportScheduleStore(path).load()).toBe('2026-07-09:08');
  });
  it('corrupt state throws loudly (no-fallback)', () => {
    writeFileSync(path, 'not json', 'utf8');
    expect(() => new FileReportScheduleStore(path).load()).toThrow();
  });
});
