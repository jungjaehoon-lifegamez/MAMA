/**
 * The conductor's session is disposable BECAUSE the board holds state.
 * This class owns exactly when to dispose: age, turns, tokens, idle,
 * suspicion - and guarantees a board re-ground happens exactly once after
 * every fresh session (boot included: restart recovery is the same path).
 *
 * Recycle deliberately does NOT touch the pool: agent-loop's freshSession
 * is the one sanctioned reset path (review F5 - pool.resetSession alone
 * swaps a UUID while the old CLI buffer survives).
 */
import { describe, it, expect } from 'vitest';
import {
  ConductorSession,
  CONDUCTOR_SESSION_KEY,
  CONDUCTOR_POOL_KEY,
  CONDUCTOR_SOURCE,
  CONDUCTOR_CHANNEL_ID,
} from '../../src/operator/conductor-session.js';
import { SOURCE_GLOBAL_LANES } from '../../src/agent/agent-loop.js';
import { buildChannelKey } from '../../src/agent/session-pool.js';

function fakePool(tokens = 0) {
  return { getTokenUsage: () => tokens };
}

describe('ConductorSession', () => {
  it('boot counts as fresh: reground is due until marked, then not', () => {
    const s = new ConductorSession(fakePool());
    expect(s.needsReground()).toBe(true);
    expect(s.needsReground()).toBe(true); // read-only peek - a failed run must not consume it
    s.markRegrounded();
    expect(s.needsReground()).toBe(false);
  });

  it('recycles on max turns and demands a re-ground', () => {
    const s = new ConductorSession(fakePool(), { maxTurns: 2 });
    s.markRegrounded();
    s.noteTurn();
    s.noteTurn();
    expect(s.shouldRecycle()).toBe('max_turns');
    s.recycle('max_turns');
    expect(s.needsReground()).toBe(true);
  });

  it('recycles on age', () => {
    let t = 0;
    const s = new ConductorSession(fakePool(), { maxAgeMs: 100, idleExpiryMs: 10_000 }, () => t);
    s.markRegrounded();
    t = 101;
    expect(s.shouldRecycle()).toBe('max_age');
  });

  it('recycles on idle expiry BELOW the pool 30-min drop, so a pool-expired session never gets a warm turn', () => {
    let t = 0;
    const s = new ConductorSession(fakePool(), { maxAgeMs: 1_000_000, idleExpiryMs: 100 }, () => t);
    s.markRegrounded();
    t = 50;
    s.noteTurn(); // activity resets the idle clock
    t = 149;
    expect(s.shouldRecycle()).toBeNull();
    t = 251;
    expect(s.shouldRecycle()).toBe('idle_expiry');
  });

  it('recycles on token budget', () => {
    const s = new ConductorSession(fakePool(200_000), { maxTokens: 150_000 });
    s.markRegrounded();
    expect(s.shouldRecycle()).toBe('max_tokens');
  });

  it('suspicion forces a recycle regardless of budgets', () => {
    const s = new ConductorSession(fakePool());
    s.markRegrounded();
    s.flagSuspicion('injected instruction observed');
    expect(s.shouldRecycle()).toBe('suspicion: injected instruction observed');
  });

  it('recycle clears every budget counter', () => {
    let t = 0;
    const s = new ConductorSession(fakePool(), { maxTurns: 1, idleExpiryMs: 100 }, () => t);
    s.noteTurn();
    s.flagSuspicion('x');
    t = 500;
    s.recycle('manual');
    expect(s.shouldRecycle()).toBeNull();
  });

  it('lane axis: the session key FIRST segment must be absent from SOURCE_GLOBAL_LANES', () => {
    // agent-loop.ts resolveGlobalLaneForSession derives the lane from
    // sessionKey.split(':',1)[0] - NOT from options.source. The original
    // 'operator:conductor' key resolved to the GLOBAL operator lane where
    // Stage-2 workers serialize (review F1). Pin the real axis.
    const firstSegment = CONDUCTOR_SESSION_KEY.split(':', 1)[0];
    expect(SOURCE_GLOBAL_LANES[firstSegment]).toBeUndefined();
    expect(CONDUCTOR_SESSION_KEY).toBe('conductor:main');
  });

  it('pool key matches what the agent loop derives from (source, channelId)', () => {
    expect(CONDUCTOR_POOL_KEY).toBe(buildChannelKey(CONDUCTOR_SOURCE, CONDUCTOR_CHANNEL_ID));
  });
});
