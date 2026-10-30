/**
 * `mama update --node` on a temp install laid out as the install command makes it (Node in
 * ~/.mama/node, the prefix in ~/.mama/npm; tests/helpers/update-install.ts): the patch move, the
 * major move with its rebuilt copy, each failure that puts the old folders back, the lock, and a
 * run killed at each step, which install/install.sh's recovery then undoes in plain sh while
 * start.sh exits at once on the hold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireInstallLock } from '../../src/cli/runtime/daemon-control.js';
import { readNodeMoveJournal } from '../../src/cli/runtime/node-move-journal.js';
import { fixture, killedAt, roots, type Fixture } from '../helpers/update-install.js';

// This Mac's live daemon has the global LaunchAgent label: nothing here may reach launchctl. Only
// `sh` runs, for install.sh and start.sh.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  const refuse = () => {
    throw new Error('a test reached a child process');
  };
  return {
    ...real,
    spawnSync: vi.fn(refuse),
    execFile: vi.fn(refuse),
    spawn: vi.fn((command: string, ...rest: unknown[]) =>
      command === 'sh'
        ? (real.spawn as (...args: unknown[]) => unknown)(command, ...rest)
        : refuse()
    ),
  };
});

const script = join(__dirname, '..', '..', 'install', 'install.sh');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function managed(): Fixture {
  return fixture({ managed: '22.23.4' });
}

const node = (f: Fixture) => join(f.root, 'node', 'bin', 'node');
const journal = (f: Fixture) => readNodeMoveJournal(join(f.root, 'runtime', 'node-move.json'));
const staged = (f: Fixture) => join(f.root, 'node.new');
const leftovers = (f: Fixture) =>
  readdirSync(f.root).filter((name) => /^(node|npm)\.(new|old)$/.test(name));
const shellCalls = (f: Fixture) =>
  existsSync(join(f.root, 'calls.log'))
    ? readFileSync(join(f.root, 'calls.log'), 'utf8').trim().split('\n')
    : [];

/** As the install command leaves it before it calls the move: the new Node in node.new. */
function stage(f: Fixture, version: string): string {
  f.writeNode(staged(f), version);
  return staged(f);
}

/** Moved or not, nothing of the move is left. */
function expectSettled(f: Fixture, version: string) {
  expect(f.versionOf(node(f))).toBe(version);
  expect(leftovers(f)).toEqual([]);
  expect(journal(f)).toBeNull();
  expect(existsSync(f.paths.hold)).toBe(false);
}

function sh(args: string[], f: Fixture, stdin?: string) {
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn('sh', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: f.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh' },
    });
    let output = '';
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
    child.stdin!.end(stdin ?? '');
  });
}

/** The install command run again, as `curl … | sh` runs it. */
const installer = (f: Fixture) =>
  sh(['-s', '--', '--backend', 'codex', '--no-init'], f, readFileSync(script, 'utf8'));

describe('mama update --node', () => {
  it('a patch pin swaps the Node only, with the service stopped, and boots on it', async () => {
    const f = managed();
    const prefix = readdirSync(f.prefix);
    expect(await f.run(['--node', stage(f, '22.24.0')])).toBe(0);
    expect(f.calls).toEqual(['stop', 'node check', 'start', 'status', 'status']);
    expectSettled(f, '22.24.0');
    expect(f.state.rebuilt).toEqual([]);
    expect(readdirSync(f.prefix)).toEqual(prefix);
    expect(f.state.runningNode).toBe('22.24.0');
    expect(f.output()).toContain('move: Node.js 22.23.4 → 22.24.0');
    expect(f.output()).toContain('moved: MAMA runs on Node.js 22.24.0 (was 22.23.4)');
  });

  it("a major pin rebuilds a copy of the prefix with the new Node's npm before the stop, and moves both", async () => {
    const f = managed();
    expect(await f.run(['--node', stage(f, '24.11.0')])).toBe(0);
    expect(f.calls).toEqual(['npm rebuild', 'stop', 'node check', 'start', 'status', 'status']);
    expect(f.state.rebuilt).toEqual([
      { prefix: join(f.root, 'npm.new'), node: join(f.root, 'node.new', 'bin', 'node') },
    ]);
    expectSettled(f, '24.11.0');
    // The prefix in place is the rebuilt copy, with the package in it.
    expect(readFileSync(join(f.prefix, 'built-for'), 'utf8')).toBe('24.11.0');
    expect(f.packageVersion()).toBe('1.0.0');
    expect(f.state.runningNode).toBe('24.11.0');
  });

  it('a failed boot puts both folders back and starts the old Node, exit 1', async () => {
    const f = managed();
    f.state.bootFailsOn = '24.11.0';
    expect(await f.run(['--node', stage(f, '24.11.0')])).toBe(1);
    expectSettled(f, '22.23.4');
    expect(existsSync(join(f.prefix, 'built-for'))).toBe(false);
    expect(f.state.runningNode).toBe('22.23.4');
    expect(f.output()).toContain(
      'moving back to Node.js 22.23.4: step 4 failed: MAMA did not finish starting'
    );
    expect(f.output()).toContain(
      'not moved: Node.js 22.23.4 runs MAMA again; Node.js 24.11.0 is removed'
    );
  });

  it("puts the old Node back when doctor's Node check fails on the new one, before any start", async () => {
    const f = managed();
    f.state.nodeCheckFailsOn = '24.11.0';
    expect(await f.run(['--node', stage(f, '24.11.0')])).toBe(1);
    expect(f.calls.slice(0, 4)).toEqual(['npm rebuild', 'stop', 'node check', 'status']);
    expectSettled(f, '22.23.4');
    expect(f.output()).toContain("step 4 failed: doctor's Node check fails on Node.js 24.11.0");
  });

  it('changes nothing when the rebuild fails, and nothing but the journal when the stop does', async () => {
    const f = managed();
    f.state.rebuildFails = true;
    await expect(f.run(['--node', stage(f, '24.11.0')])).rejects.toThrow(
      `Rebuilding ${join(f.root, 'npm.new')} with Node.js 24.11.0 failed: ELIFECYCLE; nothing else changed`
    );
    expect(f.calls).toEqual(['npm rebuild']);
    expect(journal(f)).toBeNull();
    expect(leftovers(f)).toEqual(['node.new']);
    expect(f.state.running).toBe('1.0.0');

    const g = managed();
    g.state.stopFails = true;
    expect(await g.run(['--node', stage(g, '22.24.0')])).toBe(1);
    expect(g.output()).toContain(
      'not moved: the stop did not finish (above); Node.js 22.23.4 stays'
    );
    expect(journal(g)).toBeNull();
    expect(existsSync(g.paths.hold)).toBe(false);
    expect(g.versionOf(node(g))).toBe('22.23.4');
  });

  it('refuses beside an update or a second move, which hold update.lock', async () => {
    const f = managed();
    stage(f, '22.24.0');
    const update = acquireInstallLock(f.paths.lock, 'update');
    try {
      await expect(f.run(['--node', staged(f)])).rejects.toThrow(
        /^Already updating since .+ \(update, pid \d+\)$/
      );
    } finally {
      update.release();
    }
    const move = acquireInstallLock(f.paths.lock, 'update --node');
    try {
      await expect(f.run(['--node', staged(f)])).rejects.toThrow(/\(update --node, pid \d+\)$/);
      await expect(f.run([])).rejects.toThrow(/\(update --node, pid \d+\)$/);
    } finally {
      move.release();
    }
    expect(f.calls).toEqual([]);
    expect(f.versionOf(node(f))).toBe('22.23.4');
  });

  it('refuses a Node staged elsewhere, an install the install command did not make, and an open move', async () => {
    const f = managed();
    f.writeNode(join(f.base, 'other-node'), '22.24.0');
    await expect(f.run(['--node', join(f.base, 'other-node')])).rejects.toThrow(
      `The new Node must be staged at ${staged(f)}`
    );
    const own = fixture();
    own.writeNode(join(own.root, 'node.new'), '22.24.0');
    await expect(own.run(['--node', join(own.root, 'node.new')])).rejects.toThrow(
      'mama update --node moves the Node the install command put in'
    );
    writeFileSync(
      join(f.root, 'runtime', 'node-move.json'),
      JSON.stringify({
        format: 'mama-node-move',
        phase: 'prepare',
        step: 3,
        from: '22.23.4',
        to: '22.24.0',
        major: false,
      })
    );
    await expect(f.run(['--node', stage(f, '22.24.0')])).rejects.toThrow(
      'An earlier move of the managed Node (22.23.4 → 22.24.0) is unfinished; run the install command again'
    );
    // And mama update itself waits for it.
    await expect(f.run([])).rejects.toThrow(
      'A move of the managed Node (22.23.4 → 22.24.0) is unfinished'
    );
  });

  it.each([
    // [killed at, a major move, the step it had begun, whether the hold is in place]
    ['npm rebuild#1', true, 2, false],
    ['stop#1', false, 3, false],
    ['node check#1', true, 4, true],
    ['start#1', false, 4, false],
    ['status#1', true, 4, false],
  ] as const)(
    'killed at %s: the journal (and the hold) stay, start.sh exits at once, and the install command undoes it',
    async (at, major, step, held) => {
      const f = managed();
      stage(f, major ? '24.11.0' : '22.24.0');
      await killedAt(f, at, ['--node', staged(f)]);
      expect(journal(f)).toMatchObject({ phase: 'prepare', step, major });
      expect(existsSync(f.paths.hold)).toBe(held);
      if (held) {
        // A reboot meanwhile starts nothing: start.sh exits 0 before it reads anything.
        expect((await sh([f.startPath], f)).status).toBe(0);
        expect(shellCalls(f).filter((call) => call.includes('daemon'))).toEqual([]);
      }
      const recovered = await installer(f);
      expect(recovered.status, recovered.output).toBe(1);
      expect(recovered.output).toContain(
        `the move of the managed Node from 22.23.4 to ${major ? '24.11.0' : '22.24.0'} was cut off, and is undone: MAMA runs on Node.js 22.23.4 again. Run this installer again to move it.`
      );
      expectSettled(f, '22.23.4');
      expect(existsSync(join(f.prefix, 'built-for'))).toBe(false);
      // A daemon the new Node may have started is stopped before its folders move back.
      const renamed = step === 4;
      expect(shellCalls(f)).toEqual([
        ...(renamed ? [`mama stop on ${major ? '24.11.0' : '22.24.0'}`] : []),
        `mama service start on 22.23.4`,
      ]);
    }
  );

  it('killed during its own undo, the install command finishes the undo', async () => {
    const f = managed();
    f.state.bootFailsOn = '22.24.0';
    stage(f, '22.24.0');
    // The undo's stop: the new Node's daemon does not answer, so without a drain.
    await killedAt(f, 'stop --now#1', ['--node', staged(f)]);
    expect(journal(f)).toMatchObject({ phase: 'prepare', step: 4 });
    const recovered = await installer(f);
    expect(recovered.status, recovered.output).toBe(1);
    expectSettled(f, '22.23.4');
  });
});
