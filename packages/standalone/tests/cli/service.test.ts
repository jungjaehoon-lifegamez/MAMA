import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
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
import { runStatus, runStop } from '../../src/cli/commands/control.js';
import { readStartScript, startScript } from '../../src/cli/launch-files.js';

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

function result(status: number, stdout = '', stderr = ''): SpawnSyncReturns<string> {
  return { status, stdout, stderr, signal: null, pid: 1, output: [] } as never;
}

/** launchctl print: 113 when unloaded; otherwise loaded, with a pid line when it runs. */
function launchd(state: 'unloaded' | 'idle' | 'running') {
  vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) => {
    if (command === 'launchctl' && args[0] === 'print') {
      if (state === 'unloaded') return result(113);
      return result(
        0,
        `service = {\n\tstate = ${state}\n${state === 'running' ? '\tpid = 4242\n' : ''}}`
      );
    }
    return result(0);
  }) as never);
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

const HAND_WRITTEN = [
  '#!/bin/bash',
  'source "$HOME/.mama/auth.env"',
  "export MAMA_VIEWER_HOSTNAMES='viewer.example.test'",
  `export MAMA_NOTE='it'"'"'s kept, with spaces' # a trailing note`,
  'export MAX_THINKING_TOKENS=0',
  'export MAMA_LOG_LEVEL=DEBUG',
  'export PATH="/old/bin:/opt/homebrew/bin:$PATH"',
  'DAEMON_JS="/old/cli/index.js"',
  'exec /old/node "$DAEMON_JS" daemon',
].join('\n');

describe('start.sh', () => {
  it('carries export lines verbatim, so quoting and expansion keep their meaning', () => {
    const reading = readStartScript(HAND_WRITTEN);
    expect(reading.generated).toBe(false);
    expect(reading.carried).toEqual([
      "export MAMA_VIEWER_HOSTNAMES='viewer.example.test'",
      `export MAMA_NOTE='it'"'"'s kept, with spaces' # a trailing note`,
      'export MAX_THINKING_TOKENS=0',
    ]);
    expect(reading.logLevel).toBe('DEBUG');
    expect(reading.path).toBe('"/old/bin:/opt/homebrew/bin:$PATH"');
    expect(reading.notReproduced).toEqual([
      'source "$HOME/.mama/auth.env"',
      'DAEMON_JS="/old/cli/index.js"',
    ]);

    const generated = startScript({
      home: '/fixture/home',
      nodePath: '/fixture/node',
      cliPath: '/fixture/cli.js',
      executablePaths: ['/fixture/bin/claude'],
      viewer: {},
      logLevel: 'info',
      carried: reading.carried,
    });
    const again = readStartScript(generated);
    expect(again.generated).toBe(true);
    expect(again.carried).toEqual(reading.carried);
    expect(again.notReproduced).toEqual([]);
  });
});

describe('mama service install on macOS', () => {
  it('refuses to replace a start.sh mama did not write, after naming every change', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    launchd('unloaded');
    const { home, root } = install();
    writeFileSync(join(root, 'start.sh'), HAND_WRITTEN);
    const lines: string[] = [];
    await expect(installService([], options(home, lines, { platform: 'darwin' }))).rejects.toThrow(
      'was not written by mama; check the changes above, then run mama service install --replace'
    );
    expect(lines).toContain('the daemon will run: /fixture/node /fixture/mama/dist/cli/index.js');
    expect(lines).toContain('it runs now: exec /old/node "$DAEMON_JS" daemon');
    expect(lines).toContain('carried over: MAMA_VIEWER_HOSTNAMES, MAMA_NOTE, MAX_THINKING_TOKENS');
    expect(lines).toContain('PATH no longer includes: /old/bin, /opt/homebrew/bin');
    expect(lines).toContain(
      "MAMA_LOG_LEVEL now follows config.yaml's logging.level (info); it was DEBUG"
    );
    expect(lines).toContain('not reproduced: DAEMON_JS="/old/cli/index.js"');
    expect(readFileSync(join(root, 'start.sh'), 'utf8')).toBe(HAND_WRITTEN);

    lines.length = 0;
    expect(await installService(['--replace'], options(home, lines, { platform: 'darwin' }))).toBe(
      0
    );
    const script = readFileSync(join(root, 'start.sh'), 'utf8');
    expect(script).toContain(`export MAMA_NOTE='it'"'"'s kept, with spaces' # a trailing note`);
    expect(script).toContain("export MAMA_LOG_LEVEL='INFO'");
    expect(script).toContain("exec '/fixture/node' '/fixture/mama/dist/cli/index.js' daemon");
    const kept = readdirSync(join(root, 'runtime')).filter((name) => name.startsWith('start.sh.'));
    expect(readFileSync(join(root, 'runtime', kept[0]), 'utf8')).toBe(HAND_WRITTEN);
    const plist = readFileSync(
      join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist'),
      'utf8'
    );
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(plist).toContain('<key>ExitTimeOut</key><integer>60</integer>');
    expect(lines.at(-1)).toBe('start it with: mama service start');

    // A second run changes nothing but restores a lost executable bit.
    chmodSync(join(root, 'start.sh'), 0o600);
    lines.length = 0;
    expect(await installService([], options(home, lines, { platform: 'darwin' }))).toBe(0);
    expect(lines[0]).toBe('start.sh unchanged');
    expect(statSync(join(root, 'start.sh')).mode & 0o777).toBe(0o700);
  });

  it('refuses before writing anything when the backend cannot be found', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { home, root } = install();
    await expect(
      installService([], options(home, [], { platform: 'darwin', findExecutable: () => undefined }))
    ).rejects.toThrow('claude is not on this PATH');
    expect(existsSync(join(root, 'start.sh'))).toBe(false);
  });

  it('starts an unloaded agent with bootstrap and a loaded idle one with kickstart', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { home } = install();
    const lines: string[] = [];
    await expect(startService(options(home, lines, { platform: 'darwin' }))).rejects.toThrow(
      'run mama service install'
    );
    launchd('unloaded');
    await installService([], options(home, lines, { platform: 'darwin' }));
    const run = vi.fn(() => result(0));
    expect(await startService(options(home, lines, { platform: 'darwin', run }))).toBe(0);
    expect(run).toHaveBeenLastCalledWith('launchctl', [
      'bootstrap',
      `gui/${process.getuid!()}`,
      join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist'),
    ]);
    launchd('idle');
    expect(await startService(options(home, lines, { platform: 'darwin', run }))).toBe(0);
    expect(run).toHaveBeenLastCalledWith('launchctl', [
      'kickstart',
      `gui/${process.getuid!()}/com.mama.server`,
    ]);
    launchd('running');
    lines.length = 0;
    expect(await startService(options(home, lines, { platform: 'darwin', run }))).toBe(0);
    expect(lines).toEqual(['already running']);
  });

  it('checks for the service file before a restart stops anything, and uninstalls what is there', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    launchd('unloaded');
    const { home } = install();
    await expect(
      runService(['restart'], options(home, [], { platform: 'darwin' }))
    ).rejects.toThrow('No service file yet');
    const lines: string[] = [];
    expect(await uninstallService(options(home, lines, { platform: 'darwin' }))).toBe(0);
    expect(lines).toEqual(['no LaunchAgent is installed']);
    await installService([], options(home, [], { platform: 'darwin' }));
    lines.length = 0;
    expect(await uninstallService(options(home, lines, { platform: 'darwin' }))).toBe(0);
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist'))).toBe(false);
    expect(lines.at(-1)).toMatch(
      /^service removed: .*com\.mama\.server\.plist \(start\.sh and the data stay\)$/
    );
  });
});

describe('mama service on Linux', () => {
  function linux(home: string, state = 'inactive') {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const calls: string[] = [];
    const run = vi.fn((command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args.includes('is-active')) return result(state === 'active' ? 0 : 3, `${state}\n`);
      return result(0);
    });
    const lingerRoot = join(home, 'linger');
    mkdirSync(lingerRoot, { recursive: true });
    return { calls, run, lingerRoot };
  }

  it('writes a unit that signals the daemon alone, enables it, and enables linger only when asked', async () => {
    const { home } = install();
    const { calls, run, lingerRoot } = linux(home);
    const lines: string[] = [];
    expect(
      await installService([], options(home, lines, { platform: 'linux', run, lingerRoot }))
    ).toBe(0);
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'mama.service'), 'utf8');
    expect(unit).toContain('ExecStart="%h/.mama/start.sh"');
    expect(unit).toContain('WorkingDirectory=%h/.mama');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('TimeoutStopSec=60');
    expect(calls).toContain('systemctl --user daemon-reload');
    expect(calls).toContain('systemctl --user enable mama.service');
    expect(calls.some((call) => call.startsWith('loginctl'))).toBe(false);
    expect(lines).toContain(
      'linger is off, so the service stops when you log out; run mama service install --enable-linger to keep it running'
    );
    expect(
      await installService(
        ['--enable-linger'],
        options(home, [], { platform: 'linux', run, lingerRoot })
      )
    ).toBe(0);
    expect(calls).toContain(`loginctl enable-linger ${userInfo().username}`);
    // With systemd's marker present, linger is not touched again.
    writeFileSync(join(lingerRoot, userInfo().username), '');
    calls.length = 0;
    await installService([], options(home, [], { platform: 'linux', run, lingerRoot }));
    expect(calls.some((call) => call.startsWith('loginctl'))).toBe(false);
  });

  it('stops a unit that runs or waits to restart through systemctl, and shows its state', async () => {
    const { home } = install();
    const { calls, run, lingerRoot } = linux(home, 'activating');
    await installService([], options(home, [], { platform: 'linux', run, lingerRoot }));
    const configPath = join(home, '.mama', 'config.yaml');
    const lines: string[] = [];
    expect(
      await runStop([], { home, configPath, write: (l) => lines.push(l), run, settleMs: 1 })
    ).toBe(0);
    expect(calls).toContain('systemctl --user stop mama.service');
    expect(lines).toEqual(['stopped (systemd unit stopped)']);
    lines.length = 0;
    await runStatus([], { home, configPath, write: (l) => lines.push(l), run });
    expect(lines).toContain('service: systemd (activating)');
  });

  it('removes the unit on uninstall and keeps start.sh', async () => {
    const { home, root } = install();
    const { run, lingerRoot } = linux(home);
    await installService([], options(home, [], { platform: 'linux', run, lingerRoot }));
    expect(await uninstallService(options(home, [], { platform: 'linux', run }))).toBe(0);
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', 'mama.service']);
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'mama.service'))).toBe(false);
    expect(existsSync(join(root, 'start.sh'))).toBe(true);
  });

  it('names a failing or missing service-manager command', async () => {
    const { home } = install();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const failing = vi.fn(() => result(1, '', 'Failed to connect to bus'));
    await expect(
      installService([], options(home, [], { platform: 'linux', run: failing }))
    ).rejects.toThrow('systemctl --user daemon-reload failed: Failed to connect to bus');
    const missing = vi.fn(
      () => ({ ...result(0), status: null, error: new Error('spawn systemctl ENOENT') }) as never
    );
    await expect(
      installService([], options(home, [], { platform: 'linux', run: missing }))
    ).rejects.toThrow('systemctl --user daemon-reload could not run: spawn systemctl ENOENT');
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
