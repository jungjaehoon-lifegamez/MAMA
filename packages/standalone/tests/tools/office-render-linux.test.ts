import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxSandboxArgs } from '../../src/tools/office-render.js';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'office-linux-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Pairs of a flag and its argument, as bwrap reads them. */
function mounts(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
}

it('covers denied folders and files, writes only the render folders, and has no network (L1)', () => {
  const home = join(root, 'home');
  const memberRoot = join(root, 'members');
  const secret = join(root, 'auth.env');
  fs.mkdirSync(join(home, '.mama'), { recursive: true });
  fs.mkdirSync(memberRoot);
  fs.writeFileSync(secret, 'fixture');
  const temp = join(root, 'render');
  fs.mkdirSync(temp);
  const args = linuxSandboxArgs(temp, temp, [
    home,
    join(home, '.mama'),
    memberRoot,
    secret,
    join(root, 'absent'),
  ]);
  expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
  expect(args).toContain('--unshare-net');
  expect(mounts(args, '--tmpfs')).toEqual(['/tmp', home, memberRoot]);
  // A file is covered by /dev/null; a missing path and one under a covered folder are skipped.
  expect(args.join(' ')).toContain(`--ro-bind /dev/null ${secret}`);
  expect(mounts(args, '--bind')).toEqual([temp]);
  // The render folders come after every cover, so they stay reachable.
  expect(args.lastIndexOf('--bind')).toBeGreaterThan(args.lastIndexOf('--tmpfs'));
});

it.skipIf(process.platform !== 'linux' || spawnSync('bwrap', ['--version']).status !== 0)(
  'denies reads and the network and allows the render folder, under a real bwrap',
  () => {
    const denied = join(root, 'denied');
    fs.mkdirSync(denied);
    fs.writeFileSync(join(denied, 'secret'), 'fixture secret');
    const temp = join(root, 'render');
    fs.mkdirSync(temp);
    const args = linuxSandboxArgs(temp, temp, [denied]);
    const run = (script: string) =>
      spawnSync('bwrap', [...args, '--', '/bin/sh', '-c', script], { encoding: 'utf8' });
    expect(run(`cat ${join(denied, 'secret')}`).status).not.toBe(0);
    expect(run(`echo ok > ${join(temp, 'out')} && cat ${join(temp, 'out')}`).stdout.trim()).toBe(
      'ok'
    );
    expect(run('echo x > /etc/mama-probe').status).not.toBe(0);
    // No interface but loopback: any outbound connection fails.
    expect(run('cat /sys/class/net/*/operstate | wc -l').stdout.trim()).toBe('1');
  }
);
