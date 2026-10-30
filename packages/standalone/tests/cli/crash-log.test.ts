/**
 * The service manager captures only what comes before the daemon takes over its own output, in a
 * crash log that start.sh empties at start once it is past its cap.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchAgent, readStartScript, startScript } from '../../src/cli/launch-files.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the crash log', () => {
  it('sends only what comes before the daemon takes over to a crash log capped at start', () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-crash-log-'));
    roots.push(home);
    const root = join(home, '.mama');
    mkdirSync(join(root, 'logs'), { recursive: true });
    const generated = startScript({
      home,
      nodePath: '/fixture/node',
      cliPath: '/fixture/cli.js',
      executablePaths: [],
      viewer: {},
      logLevel: 'info',
    });
    expect(generated).toContain(`daemon >> "$crash" 2>&1`);
    expect(launchAgent(home)).toContain(
      `<key>StandardOutPath</key><string>${join(root, 'logs', 'crash.log')}</string>`
    );
    // The two lines before exec, run by sh: past the cap the file is emptied, below it kept.
    const cap = generated
      .split('\n')
      .filter((line) => line.startsWith('crash=') || line.startsWith('if ['))
      .join('\n');
    const crashLog = join(root, 'logs', 'crash.log');
    writeFileSync(crashLog, 'x'.repeat(1024 * 1024 + 1));
    expect(spawnSync('sh', ['-c', cap]).status).toBe(0);
    expect(readFileSync(crashLog, 'utf8')).toBe('');
    // launchd creates it with the user's umask before start.sh runs.
    writeFileSync(crashLog, 'a crash at load\n', { mode: 0o644 });
    chmodSync(crashLog, 0o644);
    expect(spawnSync('sh', ['-c', cap]).status).toBe(0);
    expect(readFileSync(crashLog, 'utf8')).toBe('a crash at load\n');
    expect(statSync(crashLog).mode & 0o777).toBe(0o600);
  });

  it('exits 0 before anything else while mama update holds the install', () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-update-hold-'));
    roots.push(home);
    const root = join(home, '.mama');
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'runtime'));
    // A Node that records that it ran.
    const node = join(home, 'node');
    writeFileSync(node, `#!/bin/sh\necho ran > '${join(home, 'ran')}'\n`, { mode: 0o700 });
    const script = join(root, 'start.sh');
    const generated = startScript({
      home,
      nodePath: node,
      cliPath: '/fixture/cli.js',
      executablePaths: [],
      viewer: {},
      logLevel: 'info',
    });
    writeFileSync(script, generated, { mode: 0o700 });
    // mama service install reproduces the line, so it never reports it as dropped.
    expect(readStartScript(generated, home).notReproduced).toEqual([]);

    // Held: a clean exit, before auth.env (absent here) is read and before Node starts.
    writeFileSync(join(root, 'runtime', 'update.hold'), '1\n');
    expect(spawnSync(script, [], { env: { PATH: '/usr/bin:/bin' } }).status).toBe(0);
    expect(() => statSync(join(home, 'ran'))).toThrow();

    rmSync(join(root, 'runtime', 'update.hold'));
    writeFileSync(join(root, 'auth.env'), '', { mode: 0o600 });
    expect(spawnSync(script, [], { env: { PATH: '/usr/bin:/bin' } }).status).toBe(0);
    expect(readFileSync(join(home, 'ran'), 'utf8')).toBe('ran\n');
  });
});
