import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultConfigPath, loadConfig } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';
import {
  findExecutable,
  launchAgent,
  startScript,
  startScriptExports,
  systemdUnit,
} from '../launch-files.js';
import { runStatus, runStop } from './control.js';
import { launchdService } from './daemon.js';

type Manager = 'launchd' | 'systemd';
type Run = (command: string, args: string[]) => SpawnSyncReturns<string>;

export interface ServiceOptions {
  home?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  write?: (line: string) => void;
  run?: Run;
  nodePath?: string;
  cliPath?: string;
  findExecutable?: (name: string) => string | undefined;
  now?: () => Date;
}

const UNIT_NAME = 'mama.service';
const LAUNCHD_LABEL = 'com.mama.server';

function managerFor(platform: NodeJS.Platform): Manager {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  throw new CliInputError('mama service runs on macOS (launchd) and Linux (systemd)');
}

function servicePath(manager: Manager, home: string): string {
  return manager === 'launchd'
    ? join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    : join(home, '.config', 'systemd', 'user', UNIT_NAME);
}

function defaultRun(command: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: 'utf8' });
}

/** Run a service-manager command and fail loud with its own words when it fails. */
function check(run: Run, command: string, args: string[]): string {
  const result = run(command, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim() || `exit ${String(result.status)}`;
    throw new CliInputError(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return `${result.stdout ?? ''}`;
}

/** Write a file only when its content changes; the replaced start.sh is kept beside the runtime. */
function writeIfChanged(
  path: string,
  content: string,
  mode: number,
  keepPrevious?: string
): 'created' | 'updated' | 'unchanged' {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (previous === content) return 'unchanged';
  mkdirSync(dirname(path), { recursive: true });
  if (previous !== null && keepPrevious !== undefined) {
    mkdirSync(dirname(keepPrevious), { recursive: true, mode: 0o700 });
    writeFileSync(keepPrevious, previous, { mode: 0o600, flag: 'wx' });
  }
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, content, { mode });
  chmodSync(staged, mode);
  renameSync(staged, path);
  return previous === null ? 'created' : 'updated';
}

function lingerEnabled(run: Run, user: string): boolean {
  return check(run, 'loginctl', ['show-user', user, '-p', 'Linger', '--value']).trim() === 'yes';
}

/**
 * Write the start script and the service file from the current templates. Nothing restarts: a
 * running service picks the files up at `mama service restart`.
 */
export async function installService(
  args: readonly string[],
  options: ServiceOptions = {}
): Promise<number> {
  const enableLinger = args.includes('--enable-linger');
  if (args.some((arg) => arg !== '--enable-linger')) {
    throw new CliInputError('Usage: mama service install [--enable-linger]');
  }
  const home = options.home ?? homedir();
  const manager = managerFor(options.platform ?? process.platform);
  const write = options.write ?? ((line: string) => console.log(line));
  const run = options.run ?? defaultRun;
  const configPath = options.configPath ?? defaultConfigPath(home);
  const config = loadConfig({ home, path: configPath });
  const root = dirname(configPath);
  const locate = options.findExecutable ?? findExecutable;
  const startPath = join(root, 'start.sh');
  const existing = existsSync(startPath)
    ? startScriptExports(readFileSync(startPath, 'utf8'))
    : null;
  const script = startScript({
    home,
    nodePath: options.nodePath ?? process.execPath,
    cliPath: options.cliPath ?? join(__dirname, '..', 'index.js'),
    executablePaths: [locate(config.agent.backend), locate('gws')].filter(
      (path): path is string => path !== undefined
    ),
    viewer: existing?.carried ?? {},
    logLevel: config.logging.level,
  });
  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const kept = join(root, 'runtime', `start.sh.${stamp}.previous`);
  const startResult = writeIfChanged(startPath, script, 0o700, kept);
  write(`start.sh ${startResult}`);
  if (startResult === 'updated') {
    write(`the previous start.sh is kept at ${kept}`);
    if (existing && existing.dropped.length > 0) {
      write(
        `not carried over (set them elsewhere if still needed): ${existing.dropped.join(', ')}`
      );
    }
  }
  if (!locate(config.agent.backend)) {
    write(`${config.agent.backend} is not on this PATH; install it, then run this again`);
  }
  const path = servicePath(manager, home);
  const content = manager === 'launchd' ? launchAgent(home) : systemdUnit(home);
  const serviceResult = writeIfChanged(path, content, manager === 'launchd' ? 0o600 : 0o644);
  write(`${manager === 'launchd' ? 'LaunchAgent' : 'systemd user unit'} ${serviceResult}: ${path}`);
  let running = false;
  if (manager === 'launchd') {
    running = launchdService().loaded;
  } else {
    check(run, 'systemctl', ['--user', 'daemon-reload']);
    check(run, 'systemctl', ['--user', 'enable', UNIT_NAME]);
    running = run('systemctl', ['--user', 'is-active', '--quiet', UNIT_NAME]).status === 0;
    const user = userInfo().username;
    if (!lingerEnabled(run, user)) {
      if (enableLinger) {
        check(run, 'loginctl', ['enable-linger', user]);
        write('linger enabled: the service runs after you log out');
      } else {
        write(
          'linger is off, so the service stops when you log out; run mama service install --enable-linger to keep it running'
        );
      }
    }
  }
  const changed = startResult !== 'unchanged' || serviceResult !== 'unchanged';
  if (running) {
    write(
      changed
        ? 'the service is running; mama service restart applies the new files'
        : 'the service is running'
    );
  } else {
    write('start it with: mama service start');
  }
  return 0;
}

export async function startService(options: ServiceOptions = {}): Promise<number> {
  const home = options.home ?? homedir();
  const manager = managerFor(options.platform ?? process.platform);
  const write = options.write ?? ((line: string) => console.log(line));
  const run = options.run ?? defaultRun;
  const path = servicePath(manager, home);
  if (!existsSync(path)) throw new CliInputError('No service file yet: run mama service install');
  if (manager === 'launchd') {
    if (launchdService().loaded) {
      write('the LaunchAgent is already loaded');
      return 0;
    }
    check(run, 'launchctl', ['bootstrap', `gui/${process.getuid!()}`, path]);
  } else {
    check(run, 'systemctl', ['--user', 'start', UNIT_NAME]);
  }
  write('started; mama status shows its boot');
  return 0;
}

export async function uninstallService(options: ServiceOptions = {}): Promise<number> {
  const home = options.home ?? homedir();
  const manager = managerFor(options.platform ?? process.platform);
  const write = options.write ?? ((line: string) => console.log(line));
  const run = options.run ?? defaultRun;
  const path = servicePath(manager, home);
  if (manager === 'launchd') {
    // mama stop unloads a loaded LaunchAgent and waits for the daemon to let go.
    await runStop([], options);
  } else if (existsSync(path)) {
    check(run, 'systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  }
  rmSync(path, { force: true });
  if (manager === 'systemd') check(run, 'systemctl', ['--user', 'daemon-reload']);
  write(`service removed: ${path} (start.sh and the data stay)`);
  return 0;
}

export async function runService(
  args: readonly string[],
  options: ServiceOptions = {}
): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'install') return await installService(rest, options);
  if (rest.length > 0) throw new CliInputError(`Usage: mama service ${command ?? '<command>'}`);
  if (command === 'start') return await startService(options);
  if (command === 'stop') return await runStop([], options);
  if (command === 'restart') {
    const stopped = await runStop([], options);
    return stopped === 0 ? await startService(options) : stopped;
  }
  if (command === 'status') return await runStatus([], options);
  if (command === 'uninstall') return await uninstallService(options);
  throw new CliInputError('Usage: mama service install|start|stop|restart|status|uninstall');
}
