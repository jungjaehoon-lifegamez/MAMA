/**
 * The heartbeat leg is declared by BOOT, not by the scheduler: start() runs
 * before the LegCadence singleton exists, so a declare from inside it hit
 * null and the leg was silently unwatched (S2 review, blocking). The
 * scheduler's job is to publish its cadence; boot's job is the ordering.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HeartbeatScheduler } from '../../src/scheduler/heartbeat.js';
import type { AgentLoop } from '../../src/agent/agent-loop.js';

describe('HeartbeatScheduler.declaredCadence', () => {
  const scheduler = (interval: number) =>
    new HeartbeatScheduler({} as unknown as AgentLoop, { interval, channels: [] });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes its merged interval once running', () => {
    vi.useFakeTimers();
    const hb = scheduler(45_000);
    expect(hb.declaredCadence()).toBeNull(); // not running -> not a leg
    hb.start();
    expect(hb.declaredCadence()).toBe(45_000);
    hb.stop();
    expect(hb.declaredCadence()).toBeNull();
  });
});
