/**
 * Regression tests for PollingScheduler poll-state restore/persist.
 *
 * Root-caused live failure (2026-07-09): ~/.mama/connectors/poll-state.json held a LEGACY
 * NESTED schema ({lastPollTime, channels}) written by an older runtime, while restoreState
 * parsed values as flat ISO strings -> new Date(object) = Invalid Date silently stored ->
 * per-connector poll error (since.toISOString() throws) + persistState RangeError, killing
 * all inflow. Separately, the legacy calendar cursor was poisoned to 2056 (old cursor
 * semantics: max item timestamp - fatal for future-dated calendar events).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import { RawStore } from '../../src/connectors/framework/raw-store.js';

describe('PollingScheduler poll-state restore/persist', () => {
  let tmp: string;
  let rawStore: RawStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'poll-state-'));
    rawStore = new RawStore(tmp);
  });

  afterEach(() => {
    rawStore.close?.();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeState(state: unknown): void {
    writeFileSync(join(tmp, 'poll-state.json'), JSON.stringify(state), 'utf8');
  }

  it('restores flat ISO entries (current schema)', () => {
    writeState({ slack: '2026-07-01T00:00:00.000Z' });
    const s = new PollingScheduler(rawStore, tmp);
    expect(s.getLastPollTime('slack')?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('migrates legacy nested {lastPollTime, channels} entries', () => {
    writeState({
      kagemusha: { lastPollTime: '2026-06-15T13:21:39.999Z', channels: { a: '2026-07-07T13:47:55.999Z' } },
    });
    const s = new PollingScheduler(rawStore, tmp);
    expect(s.getLastPollTime('kagemusha')?.toISOString()).toBe('2026-06-15T13:21:39.999Z');
  });

  it('REJECTS a future-poisoned cursor (the 2056 calendar case) - loud warn + fresh start', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeState({
      calendar: { lastPollTime: '2056-01-07T23:59:59.999Z', channels: { calendar: '2056-01-07T23:59:59.999Z' } },
    });
    const s = new PollingScheduler(rawStore, tmp);
    expect(s.getLastPollTime('calendar')).toBeUndefined(); // falls back to default lookback
    expect(warn.mock.calls.some((c) => String(c[0]).includes('calendar'))).toBe(true);
  });

  it('REJECTS unparseable entries (object without lastPollTime, garbage string) - loud warn', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeState({ a: { channels: {} }, b: 'not-a-date' });
    const s = new PollingScheduler(rawStore, tmp);
    expect(s.getLastPollTime('a')).toBeUndefined();
    expect(s.getLastPollTime('b')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('persistState rewrites the file in FLAT schema (legacy file converges)', () => {
    writeState({
      kagemusha: { lastPollTime: '2026-06-15T13:21:39.999Z', channels: {} },
      slack: '2026-07-01T00:00:00.000Z',
    });
    const s = new PollingScheduler(rawStore, tmp);
    s.persistState();
    const onDisk = JSON.parse(readFileSync(join(tmp, 'poll-state.json'), 'utf8'));
    expect(onDisk).toEqual({
      kagemusha: '2026-06-15T13:21:39.999Z',
      slack: '2026-07-01T00:00:00.000Z',
    });
  });

  it('resetPollState / persistState refuse an invalid Date with a DESCRIPTIVE error (no cryptic RangeError)', () => {
    const s = new PollingScheduler(rawStore, tmp);
    expect(() => s.resetPollState('x', new Date('garbage'))).toThrow(/x/);
  });
});
