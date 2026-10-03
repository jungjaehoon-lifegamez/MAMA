import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionPool } from '../../src/runtime/session-pool.js';

const MINUTE = 60_000;

describe('session pool activity', () => {
  let pool: SessionPool | undefined;
  afterEach(() => {
    pool?.dispose();
    vi.useRealTimers();
  });

  it('keeps the session of a long turn that keeps working', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pool = new SessionPool();
    const { sessionId } = pool.getSession('owner');
    for (const minute of [10, 20, 30, 40]) {
      vi.setSystemTime(minute * MINUTE);
      pool.touchSession('owner');
    }
    vi.setSystemTime(50 * MINUTE);
    pool.cleanup();
    // 50 minutes into the turn: neither expired (30 min) nor force-released as stuck (15 min).
    expect(pool.peekSession('owner')).toEqual({ sessionId, busy: true });
  });

  it('still releases a turn that stopped making progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pool = new SessionPool();
    const { sessionId } = pool.getSession('owner');
    vi.setSystemTime(16 * MINUTE);
    pool.cleanup();
    expect(pool.peekSession('owner')).toEqual({ sessionId, busy: false });
  });

  it('counts expiry from the end of the last turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pool = new SessionPool();
    const { sessionId } = pool.getSession('owner');
    vi.setSystemTime(25 * MINUTE);
    pool.touchSession('owner');
    pool.releaseSession('owner');
    vi.setSystemTime(45 * MINUTE);
    // 45 minutes after the turn began but 20 after it ended: the session continues.
    expect(pool.getSession('owner')).toMatchObject({ sessionId, isNew: false });
  });
});
