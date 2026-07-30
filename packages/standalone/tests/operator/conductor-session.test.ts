/**
 * The conductor's session is disposable BECAUSE the board holds state.
 * This class owns exactly when to dispose: age, turns, tokens, suspicion -
 * and guarantees a board re-ground happens exactly once after every fresh
 * session (boot included: restart recovery is the same path).
 */
import { describe, it, expect } from 'vitest';
import { ConductorSession, CONDUCTOR_SESSION_KEY } from '../../src/operator/conductor-session.js';

function fakePool() {
  let resets = 0;
  return {
    resets: () => resets,
    getSessionId: () => 'sess-1',
    resetSession: () => {
      resets += 1;
      return `sess-${resets + 1}`;
    },
    getTokenUsage: () => 0,
  };
}

describe('ConductorSession', () => {
  it('boot counts as fresh: the first consumeReground() is true, then false', () => {
    const s = new ConductorSession(fakePool());
    expect(s.consumeReground()).toBe(true);
    expect(s.consumeReground()).toBe(false);
  });

  it('recycles on max turns and demands a re-ground', () => {
    const s = new ConductorSession(fakePool(), { maxTurns: 2 });
    s.consumeReground();
    s.noteTurn();
    s.noteTurn();
    expect(s.shouldRecycle()).toBe('max_turns');
    s.recycle('max_turns');
    expect(s.consumeReground()).toBe(true);
  });

  it('recycles on age', () => {
    let t = 0;
    const s = new ConductorSession(fakePool(), { maxAgeMs: 100 }, () => t);
    s.consumeReground();
    t = 101;
    expect(s.shouldRecycle()).toBe('max_age');
  });

  it('recycles on token budget', () => {
    const pool = { ...fakePool(), getTokenUsage: () => 200_000 };
    const s = new ConductorSession(pool, { maxTokens: 150_000 });
    s.consumeReground();
    expect(s.shouldRecycle()).toBe('max_tokens');
  });

  it('suspicion forces a recycle regardless of budgets', () => {
    const s = new ConductorSession(fakePool());
    s.consumeReground();
    s.flagSuspicion('injected instruction observed');
    expect(s.shouldRecycle()).toBe('suspicion: injected instruction observed');
  });

  it('recycle actually resets the pool session', () => {
    const pool = fakePool();
    const s = new ConductorSession(pool);
    s.recycle('manual');
    expect(pool.resets()).toBe(1);
  });

  it('exports the operator-wide key', () => {
    expect(CONDUCTOR_SESSION_KEY).toBe('operator:conductor');
  });
});
