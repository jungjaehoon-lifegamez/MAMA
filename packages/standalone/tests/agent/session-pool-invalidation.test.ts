import { afterEach, describe, expect, it } from 'vitest';
import { SessionPool } from '../../src/agent/session-pool.js';

describe('SessionPool failed-reset invalidation', () => {
  let pool: SessionPool | undefined;

  afterEach(() => {
    pool?.dispose();
  });

  it('makes the request after a failed replacement observe a genuinely new session', () => {
    pool = new SessionPool({ cleanupIntervalMs: 60_000 });
    const channelKey = 'telegram:synthetic-owner';

    pool.getSession(channelKey);
    pool.releaseSession(channelKey);
    pool.resetSession(channelKey);
    pool.invalidateSession(channelKey);

    const next = pool.getSession(channelKey);
    expect(next.isNew).toBe(true);
    expect(next.busy).toBe(false);
  });

  it('does not let an old request invalidate or release a newer replacement entry', () => {
    pool = new SessionPool({ cleanupIntervalMs: 60_000 });
    const channelKey = 'telegram:concurrent-owner';
    const old = pool.getSession(channelKey);

    pool.invalidateSession(channelKey, old.sessionId);
    const replacement = pool.getSession(channelKey);
    pool.invalidateSession(channelKey, old.sessionId);
    pool.releaseSession(channelKey, old.sessionId);

    expect(pool.getSessionInfo(channelKey)?.sessionId).toBe(replacement.sessionId);
    expect(pool.peekSession(channelKey).busy).toBe(true);
  });
});
