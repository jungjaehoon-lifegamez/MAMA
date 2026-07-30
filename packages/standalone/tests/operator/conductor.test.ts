/**
 * The conductor consumes durable batches on ITS OWN lane and never the
 * global operator lane (workers serialize there; awaiting one from a model
 * turn deadlocks - worker-run.ts documents the seal). It re-grounds after
 * every fresh session, acks only successful judgments, and returns failed
 * claims to the inbox instead of losing them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { ConductorInbox } from '../../src/operator/conductor-inbox.js';
import { ConductorSession, CONDUCTOR_SESSION_KEY } from '../../src/operator/conductor-session.js';
import { Conductor } from '../../src/operator/conductor.js';
import { SOURCE_GLOBAL_LANES } from '../../src/agent/agent-loop.js';

function fakePool() {
  return { getSessionId: () => 's', resetSession: () => 's2', getTokenUsage: () => 0 };
}

type RunOptions = {
  sessionKey?: string;
  source?: string;
  channelId?: string;
  resumeSession?: boolean;
};

describe('Conductor', () => {
  let db: SQLiteDatabase;
  let inbox: ConductorInbox;
  let calls: Array<{ prompt: string; options?: RunOptions }>;

  const runner = (fail = false) => ({
    run: async (prompt: string, options?: RunOptions) => {
      calls.push({ prompt, options });
      if (fail) throw new Error('model unavailable');
      return { response: 'ok' };
    },
  });

  beforeEach(() => {
    db = new Database(':memory:');
    inbox = new ConductorInbox(db);
    calls = [];
  });

  it('conductor is NOT a global lane: a one-line addition must fail here first', () => {
    expect(SOURCE_GLOBAL_LANES).not.toHaveProperty('conductor');
  });

  it('first tick re-grounds, runs on the conductor session key, and acks', async () => {
    inbox.enqueue({ channelKey: 'chat C1', eventIds: ['e1'], lines: ['hello'] });
    const c = new Conductor({
      inbox,
      session: new ConductorSession(fakePool()),
      runner: runner(),
      reground: () => '[BOARD REGROUND]\n- #1 [pending] a card\n[/BOARD REGROUND]',
    });
    expect(await c.tick()).toBe('processed');
    expect(calls[0].options?.sessionKey).toBe(CONDUCTOR_SESSION_KEY);
    expect(calls[0].options?.source).toBe('conductor');
    expect(calls[0].options?.resumeSession).toBe(false); // fresh session: no resume
    expect(calls[0].options?.channelId).toBe('conductor'); // pool identity, agent-loop.ts buildChannelKey
    expect(calls[0].prompt).toContain('[BOARD REGROUND]');
    expect(calls[0].prompt).toContain('hello');
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
  });

  it('warm turns do NOT re-ground and resume the session', async () => {
    inbox.enqueue({ channelKey: 'c C1', eventIds: ['e1'], lines: ['one'] });
    inbox.enqueue({ channelKey: 'c C2', eventIds: ['e2'], lines: ['two'] });
    const c = new Conductor({
      inbox,
      session: new ConductorSession(fakePool()),
      runner: runner(),
      reground: () => '[BOARD REGROUND]x[/BOARD REGROUND]',
    });
    await c.tick();
    if (calls.length < 2) await c.tick();
    expect(calls[1].prompt).not.toContain('[BOARD REGROUND]');
    expect(calls[1].options?.resumeSession).toBe(true); // warm session: CONTINUE
  });

  it('a failed run returns the claim to the inbox - nothing is lost', async () => {
    inbox.enqueue({ channelKey: 'c C1', eventIds: ['e1'], lines: ['x'] });
    const c = new Conductor({
      inbox,
      session: new ConductorSession(fakePool()),
      runner: runner(true),
      reground: () => '',
    });
    expect(await c.tick()).toBe('failed');
    expect(inbox.depth().pending).toBe(1);
  });

  it('idle when the inbox is empty', async () => {
    const c = new Conductor({
      inbox,
      session: new ConductorSession(fakePool()),
      runner: runner(),
      reground: () => '',
    });
    expect(await c.tick()).toBe('idle');
  });

  it('a burst is bounded per tick and the remaining depth is loud', async () => {
    for (let i = 0; i < 3; i++) {
      inbox.enqueue({ channelKey: `c C${i}`, eventIds: [`e${i}`], lines: [`m${i}`] });
    }
    const logs: string[] = [];
    const c = new Conductor({
      inbox,
      session: new ConductorSession(fakePool()),
      runner: runner(),
      reground: () => '',
      log: (line) => logs.push(line),
      maxBatchesPerTick: 2,
    });
    expect(await c.tick()).toBe('processed');
    expect(calls).toHaveLength(2);
    expect(inbox.depth().pending).toBe(1);
    expect(logs.some((l) => l.includes('1 pending'))).toBe(true);
  });
});
