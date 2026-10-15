import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  installService,
  runService,
  startService,
  uninstallService,
} from '../../src/cli/commands/service.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

const platform = process.platform;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockReset();
  Object.defineProperty(process, 'platform', { value: platform });
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function result(status: number, stdout = ''): SpawnSyncReturns<string> {
  return { status, stdout, stderr: '', signal: null, pid: 1, output: [] } as never;
}

function install(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), 'mama-service-'));
  roots.push(home);
  const root = join(home, '.mama');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'config.yaml'),
    JSON.stringify({
      version: 1,
      agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram: { enabled: false },
    })
  );
  return { home, root };
}

const options = (home: string, lines: string[], extra: Record<string, unknown> = {}) => ({
  home,
  write: (line: string) => lines.push(line),
  nodePath: '/fixture/node',
  cliPath: '/fixture/mama/dist/cli/index.js',
  findExecutable: (name: string) => `/fixture/bin/${name}`,
  now: () => new Date('2026-10-16T01:00:00Z'),
  ...extra,
});

describe('mama service install on macOS', () => {
  it('writes start.sh and a LaunchAgent that restarts only on failure, keeping the viewer access', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(spawnSync).mockReturnValue(result(113));
    const { home, root } = install();
    writeFileSync(
      join(root, 'start.sh'),
      [
        '#!/bin/bash',
        "export MAMA_VIEWER_HOSTNAMES='viewer.example.test'",
        "export MAMA_CF_ACCESS_AUD='aud-fixture'",
        'export MAMA_LEGACY_FLAG=1',
        'export MAMA_LOG_LEVEL=ERROR',
        'export PATH="/old/bin:$PATH"',
        'exec /old/node /old/cli daemon',
      ].join('\n')
    );
    const lines: string[] = [];
    expect(await installService([], options(home, lines, { platform: 'darwin' }))).toBe(0);

    const script = readFileSync(join(root, 'start.sh'), 'utf8');
    expect(script).toContain("export MAMA_VIEWER_HOSTNAMES='viewer.example.test'");
    expect(script).toContain("export MAMA_CF_ACCESS_AUD='aud-fixture'");
    expect(script).not.toContain('MAMA_LEGACY_FLAG');
    expect(script).toContain("exec '/fixture/node' '/fixture/mama/dist/cli/index.js' daemon");
    // config.yaml's logging.level reaches the core logger only through this variable.
    expect(script).toContain("export MAMA_LOG_LEVEL='INFO'");
    expect(statSync(join(root, 'start.sh')).mode & 0o777).toBe(0o700);
    const kept = readdirSync(join(root, 'runtime')).filter((name) => name.startsWith('start.sh.'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(root, 'runtime', kept[0]), 'utf8')).toContain('MAMA_LEGACY_FLAG=1');
    expect(lines).toContain(
      'not carried over (set them elsewhere if still needed): MAMA_LEGACY_FLAG'
    );

    const plist = readFileSync(
      join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist'),
      'utf8'
    );
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(plist).toContain('<key>ExitTimeOut</key><integer>60</integer>');
    expect(lines.at(-1)).toBe('start it with: mama service start');

    lines.length = 0;
    expect(await installService([], options(home, lines, { platform: 'darwin' }))).toBe(0);
    expect(lines.slice(0, 2)).toEqual([
      'start.sh unchanged',
      `LaunchAgent unchanged: ${join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist')}`,
    ]);
  });

  it('bootstraps the LaunchAgent on start and refuses before install', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { home } = install();
    const lines: string[] = [];
    await expect(startService(options(home, lines, { platform: 'darwin' }))).rejects.toThrow(
      'run mama service install'
    );
    vi.mocked(spawnSync).mockReturnValue(result(113));
    await installService([], options(home, lines, { platform: 'darwin' }));
    const run = vi.fn(() => result(0));
    expect(await startService(options(home, lines, { platform: 'darwin', run }))).toBe(0);
    expect(run).toHaveBeenCalledWith('launchctl', [
      'bootstrap',
      `gui/${process.getuid!()}`,
      join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist'),
    ]);
  });
});

describe('mama service install on Linux', () => {
  it('writes a systemd user unit, enables it, and enables linger only when asked', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { home, root } = install();
    const calls: string[] = [];
    let linger = 'no';
    const run = vi.fn((command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'loginctl' && args[0] === 'show-user') return result(0, `${linger}\n`);
      if (command === 'loginctl' && args[0] === 'enable-linger') linger = 'yes';
      if (args.includes('is-active')) return result(3);
      return result(0);
    });
    const lines: string[] = [];
    expect(await installService([], options(home, lines, { platform: 'linux', run }))).toBe(0);
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'mama.service'), 'utf8');
    expect(unit).toContain(`ExecStart=${join(root, 'start.sh')}`);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('TimeoutStopSec=60');
    expect(calls).toContain('systemctl --user daemon-reload');
    expect(calls).toContain('systemctl --user enable mama.service');
    expect(calls.some((call) => call.startsWith('loginctl enable-linger'))).toBe(false);
    expect(lines).toContain(
      'linger is off, so the service stops when you log out; run mama service install --enable-linger to keep it running'
    );

    lines.length = 0;
    expect(
      await installService(['--enable-linger'], options(home, lines, { platform: 'linux', run }))
    ).toBe(0);
    expect(calls).toContain(`loginctl enable-linger ${userInfo().username}`);
    expect(lines).toContain('linger enabled: the service runs after you log out');
  });

  it('removes the unit on uninstall and keeps start.sh', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { home, root } = install();
    const run = vi.fn((command: string, args: string[]) =>
      command === 'loginctl'
        ? result(0, 'yes\n')
        : args.includes('is-active')
          ? result(3)
          : result(0)
    );
    await installService([], options(home, [], { platform: 'linux', run }));
    const lines: string[] = [];
    expect(await uninstallService(options(home, lines, { platform: 'linux', run }))).toBe(0);
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', 'mama.service']);
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'mama.service'))).toBe(false);
    expect(existsSync(join(root, 'start.sh'))).toBe(true);
  });

  it('names a failing service-manager command in its own words', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { home } = install();
    const run = vi.fn(() => ({ ...result(1), stderr: 'Failed to connect to bus' }) as never);
    await expect(installService([], options(home, [], { platform: 'linux', run }))).rejects.toThrow(
      'systemctl --user daemon-reload failed: Failed to connect to bus'
    );
  });
});

describe('mama service elsewhere', () => {
  it('refuses on a platform without launchd or systemd, and rejects unknown commands', async () => {
    const { home } = install();
    await expect(installService([], options(home, [], { platform: 'win32' }))).rejects.toThrow(
      'mama service runs on macOS (launchd) and Linux (systemd)'
    );
    await expect(runService(['bounce'], options(home, []))).rejects.toThrow(
      'Usage: mama service install|start|stop|restart|status|uninstall'
    );
  });
});
