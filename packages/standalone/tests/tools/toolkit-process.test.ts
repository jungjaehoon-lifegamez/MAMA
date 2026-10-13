import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { liveToolkitLease, tryToolkitLock } from '../../src/tools/toolkit-process.js';

let root: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'toolkit-process-')));
});
afterEach(() => {
  if (existsSync(join(root, 'command'))) {
    try {
      process.kill(-Number(readFileSync(join(root, 'command'), 'utf8')), 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

it('stores the owner PID, names live leases and recovers dead locks', () => {
  const path = join(root, 'lock');
  const release = tryToolkitLock(path)!;
  try {
    const owner = join(path, readdirSync(path)[0]!);
    expect(readFileSync(owner, 'utf8')).toBe(String(process.pid));
    expect(tryToolkitLock(path)).toBeNull();
    expect(liveToolkitLease(owner)).toBe(true);
  } finally {
    release();
  }
  writeFileSync(path, '2147483647');
  expect(liveToolkitLease(path)).toBe(false);
  tryToolkitLock(path)!();
  expect(existsSync(path)).toBe(false);
});

it.each([
  ['cli', 'SIGINT', 130],
  ['cli', 'SIGHUP', 129],
  ['cli', 'SIGTERM', 143],
  ['daemon', 'SIGINT', 0],
  ['daemon', 'SIGTERM', 0],
] as const)(
  '%s on %s kills children and releases locks/leases while preserving its exit policy',
  async (mode, signal, code) => {
    // Compile only these host helpers, then run Node fixtures. No backend or installer CLI runs.
    for (const name of ['toolkit-process', 'command-runner']) {
      const source = readFileSync(join(__dirname, '../../src/tools', `${name}.ts`), 'utf8');
      writeFileSync(
        join(root, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText
      );
    }
    const heartbeat = join(root, 'heartbeat');
    const descendantScript = `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'descendant'))}, String(process.pid)); setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 10);`;
    const commandScript = `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'command'))}, String(process.pid)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio: 'ignore'}); setInterval(() => { if (!require('node:fs').existsSync(${JSON.stringify(root)})) process.exit(1); }, 100);`;
    const installLock = join(root, '.install-lock');
    const stateLock = join(root, '.state-lock');
    const lease = join(root, 'lease');
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `
      const {tryToolkitLock, onToolkitSignal} = require(${JSON.stringify(join(root, 'toolkit-process.js'))});
      const {runCommand} = require(${JSON.stringify(join(root, 'command-runner.js'))});
      if (${JSON.stringify(mode)} === 'cli') onToolkitSignal(() => {}, {exit: true});
      else process.once(${JSON.stringify(signal)}, () => {
        setTimeout(() => {
          require('node:fs').writeFileSync(${JSON.stringify(join(root, 'graceful-stop'))}, 'finished');
          process.exit(0);
        }, 80);
      });
      tryToolkitLock(${JSON.stringify(installLock)});
      tryToolkitLock(${JSON.stringify(stateLock)});
      require('node:fs').writeFileSync(${JSON.stringify(lease)}, String(process.pid));
      onToolkitSignal(() => require('node:fs').rmSync(${JSON.stringify(lease)}));
      runCommand(process.execPath, ['-e', ${JSON.stringify(commandScript)}]).catch(() => {});
    `,
      ],
      { stdio: 'ignore' }
    );
    children.push(parent);
    const exited = new Promise<number | null>((resolve, reject) => {
      parent.once('exit', resolve);
      parent.once('error', reject);
    });
    const deadline = Date.now() + 3000;
    while (!existsSync(heartbeat) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(heartbeat)).toBe(true);
    const commandPid = Number(readFileSync(join(root, 'command'), 'utf8'));
    try {
      parent.kill(signal);
      expect(await exited).toBe(code);
      expect(existsSync(join(root, 'graceful-stop'))).toBe(mode === 'daemon');
      for (const path of [installLock, stateLock, lease]) expect(existsSync(path)).toBe(false);
      // A grandchild may briefly remain a zombie; a stopped heartbeat proves it cannot run.
      const afterExit = readFileSync(heartbeat, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFileSync(heartbeat, 'utf8')).toBe(afterExit);
      // The command and descendant were killed together, before lock cleanup.
    } finally {
      try {
        process.kill(-commandPid, 'SIGKILL');
      } catch {
        /* Already reaped. */
      }
    }
  }
);
