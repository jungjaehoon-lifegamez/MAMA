/**
 * An empty HEARTBEAT.md must never wake the model. One accumulated heartbeat
 * thread burned 13.4M tokens over 9 days (2026-08-06..15) answering 290
 * "[HEARTBEAT POLL] ... (none)" turns with "HEARTBEAT_OK". Emptiness is a
 * host-side fact - the scheduler checks the file itself, and when there IS
 * work it runs a stateless fresh session instead of resuming a durable thread.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HeartbeatScheduler } from '../../src/scheduler/heartbeat.js';
import type { AgentLoop } from '../../src/agent/agent-loop.js';

describe('HeartbeatScheduler empty-file skip', () => {
  // One HOME for the whole suite: getMemoryLogger() is a singleton that
  // captures its base path on first use, so per-test homes would leave it
  // writing into a deleted directory.
  let home: string;
  let savedHome: string | undefined;
  let run: ReturnType<typeof vi.fn>;

  const scheduler = () =>
    new HeartbeatScheduler({ run } as unknown as AgentLoop, {
      quietStart: 0,
      quietEnd: 0, // hour >= 0 && hour < 0 is never true -> never quiet
    });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'mama-heartbeat-'));
    mkdirSync(join(home, '.mama', 'memory'), { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  beforeEach(() => {
    rmSync(join(home, '.mama', 'HEARTBEAT.md'), { force: true });
    run = vi.fn(async () => ({ response: 'HEARTBEAT_OK' }));
  });

  afterAll(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('does not call the model when HEARTBEAT.md is missing', async () => {
    await scheduler().triggerNow();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not call the model when HEARTBEAT.md is whitespace only', async () => {
    writeFileSync(join(home, '.mama', 'HEARTBEAT.md'), '  \n\n\t\n');
    await scheduler().triggerNow();
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a stateless fresh session when HEARTBEAT.md has tasks', async () => {
    writeFileSync(join(home, '.mama', 'HEARTBEAT.md'), '- check the deploy\n');
    await scheduler().triggerNow();
    expect(run).toHaveBeenCalledTimes(1);
    const [prompt, options] = run.mock.calls[0];
    expect(String(prompt)).toContain('check the deploy');
    expect(options).toMatchObject({ freshSession: true });
  });
});
