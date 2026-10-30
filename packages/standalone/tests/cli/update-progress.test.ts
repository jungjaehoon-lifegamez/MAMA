/**
 * What an /update's chat hears from `mama update` (docs/development/work/update.md, PR 4): the
 * update job sets MAMA_UPDATE_PROGRESS=telegram, and the CLI, the new version's `--continue` and
 * a rollback's CLI report through the Bot API's sendMessage. A group may read it: versions, step
 * names and error codes only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateRequestPath } from '../../src/cli/runtime/update-request.js';
import { progressText, type UpdateProgress } from '../../src/cli/runtime/update-progress.js';
import { fixture, roots, type Fixture } from '../helpers/update-install.js';

vi.mock('node:child_process', async (original) => {
  const refuse = () => {
    throw new Error('a test reached a child process');
  };
  return {
    ...(await original<typeof import('node:child_process')>()),
    spawnSync: vi.fn(refuse),
    spawn: vi.fn(refuse),
    execFile: vi.fn(refuse),
  };
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BOT_TOKEN = 'fixture-bot-token-value';
const CHAT = '-7001';

function reported(options: Parameters<typeof fixture>[0] = {}): Fixture {
  const f = fixture({ ...options, env: { MAMA_UPDATE_PROGRESS: 'telegram', ...options.env } });
  writeFileSync(join(f.root, 'auth.env'), `MAMA_TELEGRAM_TOKEN='${BOT_TOKEN}'\n`, { mode: 0o600 });
  writeFileSync(
    updateRequestPath(f.root),
    JSON.stringify({ chatId: CHAT, messageId: 31, receivedAt: '2026-10-30T00:00:00.000Z' }),
    { mode: 0o600 }
  );
  return f;
}

const texts = (f: Fixture) => f.telegram.map((call) => call.params.text);

/** Every send went to the origin through sendMessage, and holds no path, CLI text or secret. */
function expectSafe(f: Fixture, failures: string[] = []) {
  expect(f.telegram.length).toBeGreaterThan(0);
  for (const call of f.telegram) {
    expect(call.method).toBe('sendMessage');
    expect(call.token).toBe(BOT_TOKEN);
    expect(Object.keys(call.params).sort()).toEqual(['chat_id', 'text']);
    expect(call.params.chat_id).toBe(CHAT);
    const text = call.params.text;
    expect(text).not.toMatch(/\/[A-Za-z.]/);
    for (const part of [f.root, f.prefix, f.home, BOT_TOKEN, 'registry.fixture.test', ...failures])
      expect(text).not.toContain(part);
  }
}

describe('/update progress', () => {
  it('reports the steps of a clean update, the new version included', async () => {
    const f = reported();
    expect(await f.run([])).toBe(0);
    expect(texts(f)).toEqual([
      'update 1.0.0 → 1.1.0: starting',
      'update 1.0.0 → 1.1.0: step 5 (stage the new version)',
      'update 1.0.0 → 1.1.0: step 6 (drain and stop)',
      'update 1.0.0 → 1.1.0: step 7 (snapshot)',
      'update 1.0.0 → 1.1.0: step 8 (swap)',
      'update 1.0.0 → 1.1.0: step 9 (hand over to the new version)',
      // The new version's `update --continue`: it inherited MAMA_UPDATE_PROGRESS.
      'update 1.0.0 → 1.1.0: step 10 (service files)',
      'update 1.0.0 → 1.1.0: step 11 (doctor)',
      'update 1.0.0 → 1.1.0: step 12 (toolkit)',
      'update 1.0.0 → 1.1.0: step 13 (start held)',
      'update 1.0.0 → 1.1.0: step 14 (wait for the boot)',
      'updated: 1.0.0 → 1.1.0; it runs',
    ]);
    expectSafe(f);
    expect(f.childEnvs.every((env) => env.MAMA_UPDATE_PROGRESS === 'telegram')).toBe(true);
  });

  it('reports a failed step and the rollback by step name and code, not by its message', async () => {
    const f = reported({ releases: { '1.1.0': { doctorFails: 'backend.signed_out' } } });
    expect(await f.run([])).toBe(1);
    expect(texts(f).slice(-3)).toEqual([
      'update 1.0.0 → 1.1.0: step 11 (doctor) failed: backend.signed_out',
      'rolling back to 1.0.0',
      'rolled back: 1.0.0 runs again; step 11 (doctor) of the update to 1.1.0 failed',
    ]);
    expectSafe(f, ['mama doctor --offline fails']);
  });

  it('reports a step that fails with a message only (a path in it) without the message', async () => {
    const f = reported({ releases: { '1.1.0': { installFails: true } } });
    expect(await f.run([])).toBe(1);
    expect(texts(f)).toContain('update 1.0.0 → 1.1.0: step 10 (service files) failed');
    expectSafe(f, ['codex is not on this PATH']);
  });

  it('reports a refusal and a stop that failed by their codes', async () => {
    const current = reported({ from: '1.1.0' });
    expect(await current.run([])).toBe(0);
    expect(texts(current)).toEqual(['already on 1.1.0']);

    const older = reported({ from: '1.1.0' });
    await expect(older.run(['1.0.0'])).rejects.toThrow('is older than');
    expect(texts(older)).toEqual([
      "update ended: update.older; the update log on MAMA's machine has the details",
    ]);

    const missing = reported();
    await expect(missing.run(['9.9.9'])).rejects.toThrow('npm E404');
    expect(texts(missing)).toEqual([
      "update ended: npm.E404; the update log on MAMA's machine has the details",
    ]);

    const stop = reported();
    stop.state.stopFails = true;
    expect(await stop.run([])).toBe(1);
    expect(texts(stop).at(-1)).toBe(
      'not updated: step 6 (drain and stop) failed: stop.failed; 1.0.0 stays installed'
    );
    for (const f of [current, older, missing, stop]) expectSafe(f, ['Refused', 'nothing changed']);
  });

  it('logs a send that fails to update.log and goes on with the update', async () => {
    const unreachable = reported();
    unreachable.state.telegramFails = true;
    expect(await unreachable.run([])).toBe(0);
    expect(unreachable.state.running).toBe('1.1.0');
    expect(unreachable.output()).toContain('update progress not sent: TypeError: fetch failed');

    const refused = reported();
    refused.state.telegramFails = 403;
    expect(await refused.run([])).toBe(0);
    expect(refused.output()).toContain('update progress not sent: Telegram answered 403');
    // The token is never written to the log.
    expect(refused.output()).not.toContain(BOT_TOKEN);
  });

  it("sends nothing for an owner's own mama update", async () => {
    const f = fixture();
    expect(await f.run([])).toBe(0);
    expect(f.telegram).toEqual([]);
  });

  it('builds texts from versions, step numbers and codes alone', () => {
    const events: UpdateProgress[] = [
      { kind: 'plan', from: '/var/fixture/.mama', to: '1.1.0' },
      { kind: 'failed', from: '1.0.0', to: '1.1.0', step: 11, code: 'fails at /tmp/x: reason' },
      { kind: 'error', code: 'Could not ask http://registry' },
    ];
    expect(events.map(progressText)).toEqual([
      'update unknown → 1.1.0: starting',
      'update 1.0.0 → 1.1.0: step 11 (doctor) failed',
      "update ended: UNKNOWN; the update log on MAMA's machine has the details",
    ]);
  });
});
