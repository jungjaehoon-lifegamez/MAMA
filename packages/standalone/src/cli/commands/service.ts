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
  readStartScript,
  stableNodePath,
  startPathEntries,
  startPathValue,
  startScript,
  systemdUnit,
} from '../launch-files.js';
import {
  defaultServiceRun,
  SYSTEMD_UNIT,
  systemdUnitPath,
  systemdUnitState,
  type ServiceRun,
} from '../runtime/systemd-service.js';
import { runStatus, runStop } from './control.js';
import { launchdService } from './daemon.js';

type Manager = 'launchd' | 'systemd';

export interface ServiceOptions {
  home?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  write?: (line: string) => void;
  run?: ServiceRun;
  nodePath?: string;
  cliPath?: string;
  findExecutable?: (name: string) => string | undefined;
  now?: () => Date;
  /** Where systemd keeps linger markers; tests point it elsewhere. */
  lingerRoot?: string;
  /** Which package-manager tool folders exist; tests name them, by default this machine's. */
  toolDirectoryExists?: (path: string) => boolean;
  /** The viewer's tunnel settings `mama init` collected, written into start.sh. */
  viewer?: Record<string, string>;
}

const LAUNCHD_LABEL = 'com.mama.server';

function managerFor(platform: NodeJS.Platform): Manager {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  throw new CliInputError('mama service runs on macOS (launchd) and Linux (systemd)');
}

function servicePath(manager: Manager, home: string): string {
  return manager === 'launchd'
    ? join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    : systemdUnitPath(home);
}

/** Run a service-manager command and fail loud with its name and its own words. */
function check(run: ServiceRun, command: string, args: string[]): string {
  const result = run(command, args);
  if (result.error) {
    throw new CliInputError(`${command} ${args.join(' ')} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim() || `exit ${String(result.status)}`;
    throw new CliInputError(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return `${result.stdout ?? ''}`;
}

/**
 * Write a file only when its content changes, always leaving the requested mode; a replaced file
 * is kept under runtime/, which the agents' native reads deny.
 */
function writeFile(
  path: string,
  content: string,
  mode: number,
  keepAs: string
): 'created' | 'updated' | 'unchanged' {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (previous === content) {
    chmodSync(path, mode);
    return 'unchanged';
  }
  mkdirSync(dirname(path), { recursive: true });
  if (previous !== null) {
    mkdirSync(dirname(keepAs), { recursive: true, mode: 0o700 });
    writeFileSync(keepAs, previous, { mode: 0o600, flag: 'wx' });
  }
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, content, { mode });
  chmodSync(staged, mode);
  renameSync(staged, path);
  return previous === null ? 'created' : 'updated';
}

function serviceRunning(manager: Manager, home: string, run: ServiceRun): boolean {
  if (manager === 'launchd') return launchdService().pid !== null;
  return systemdUnitState(home, run, 'linux') === 'active';
}

/** Whether the installed service runs the daemon now. */
export function serviceRuns(options: ServiceOptions = {}): boolean {
  return serviceRunning(
    managerFor(options.platform ?? process.platform),
    options.home ?? homedir(),
    options.run ?? defaultServiceRun
  );
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

/**
 * Write start.sh and the service file from the current templates. It names every change to what
 * the daemon runs, refuses to replace a start.sh that mama did not write unless asked, and
 * restarts nothing: a running service takes the files at `mama service restart`.
 */
/** The service file `mama service install` writes on this platform. */
export function serviceFile(options: ServiceOptions = {}): string {
  return servicePath(managerFor(options.platform ?? process.platform), options.home ?? homedir());
}

export async function installService(
  args: readonly string[],
  options: ServiceOptions = {}
): Promise<number> {
  const flags = new Set(args);
  for (const flag of flags) {
    if (flag !== '--enable-linger' && flag !== '--replace') {
      throw new CliInputError('Usage: mama service install [--enable-linger] [--replace]');
    }
  }
  const home = options.home ?? homedir();
  const manager = managerFor(options.platform ?? process.platform);
  const write = options.write ?? ((line: string) => console.log(line));
  const run = options.run ?? defaultServiceRun;
  const configPath = options.configPath ?? defaultConfigPath(home);
  const config = loadConfig({ home, path: configPath });
  const root = dirname(configPath);
  const locate = options.findExecutable ?? findExecutable;
  const backend = locate(config.agent.backend);
  if (!backend) {
    throw new CliInputError(
      `${config.agent.backend} is not on this PATH; install it or add it to PATH, then run mama service install again`
    );
  }
  const gws = locate('gws');
  const nodePath = options.nodePath ?? stableNodePath(process.execPath);
  const cliPath = options.cliPath ?? join(__dirname, '..', 'index.js');
  const executablePaths = [backend, ...(gws ? [gws] : [])];
  const startPath = join(root, 'start.sh');
  const existing = existsSync(startPath) ? readFileSync(startPath, 'utf8') : null;
  const reading = existing === null ? null : readStartScript(existing, home);
  const script = startScript({
    home,
    nodePath,
    cliPath,
    executablePaths,
    ...(options.toolDirectoryExists ? { exists: options.toolDirectoryExists } : {}),
    viewer: options.viewer ?? {},
    logLevel: config.logging.level,
    // A value init passes again replaces the line it wrote last time instead of repeating it.
    carried: (reading?.carried ?? []).filter(
      (line) =>
        !Object.hasOwn(
          options.viewer ?? {},
          /^export\s+([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? ''
        )
    ),
  });

  // Only a start.sh that is about to change is reported; a matching one needs no account.
  if (reading !== null && existing !== script) {
    const execLine = script.split('\n').find((line) => line.startsWith('exec '));
    if (reading.exec !== execLine) {
      write(`the daemon will run: ${nodePath} ${cliPath}`);
      write(`it runs now: ${reading.exec ?? '(no exec line)'}`);
    }
    if (reading.carried.length > 0) {
      const names = reading.carried.map((line) => line.replace(/^export\s+/, '').split('=')[0]);
      write(`carried over: ${names.join(', ')}`);
    }
    const kept = startPathEntries({
      nodePath,
      executablePaths,
      ...(options.toolDirectoryExists ? { exists: options.toolDirectoryExists } : {}),
    });
    // $HOME in the old PATH is the same folder the new one names in full.
    let oldPath: string[] = [];
    try {
      oldPath = reading.path === null ? [] : startPathValue(reading.path, home);
    } catch {
      // A broken quote is what --replace repairs; say so instead of refusing.
      write('the old PATH cannot be read (its quoting is broken)');
    }
    const lost = oldPath.filter((entry) => !kept.includes(entry));
    if (lost.length > 0) write(`PATH no longer includes: ${lost.join(', ')}`);
    if (
      reading.logLevel !== null &&
      unquote(reading.logLevel).toUpperCase() !== config.logging.level.toUpperCase()
    ) {
      write(
        `MAMA_LOG_LEVEL now follows config.yaml's logging.level (${config.logging.level}); it was ${reading.logLevel}`
      );
    }
    for (const line of reading.notReproduced.slice(0, 20)) {
      write(`not reproduced: ${line.slice(0, 120)}`);
    }
    if (reading.notReproduced.length > 20) {
      write(`not reproduced: ${reading.notReproduced.length - 20} more lines`);
    }
    if (!reading.generated && !flags.has('--replace')) {
      throw new CliInputError(
        `${startPath} was not written by mama; check the changes above, then run mama service install --replace`
      );
    }
  }
  if (!gws) write('gws is not on this PATH; Google sources need it');

  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const keep = (name: string) => join(root, 'runtime', `${name}.${stamp}.previous`);
  const startResult = writeFile(startPath, script, 0o700, keep('start.sh'));
  write(
    `start.sh ${startResult}${startResult === 'updated' ? `; the previous one is kept at ${keep('start.sh')}` : ''}`
  );
  const path = servicePath(manager, home);
  const content = manager === 'launchd' ? launchAgent(home) : systemdUnit();
  const serviceResult = writeFile(
    path,
    content,
    manager === 'launchd' ? 0o600 : 0o644,
    keep(manager === 'launchd' ? 'launchagent.plist' : SYSTEMD_UNIT)
  );
  write(`${manager === 'launchd' ? 'LaunchAgent' : 'systemd user unit'} ${serviceResult}: ${path}`);
  if (manager === 'systemd') {
    check(run, 'systemctl', ['--user', 'daemon-reload']);
    check(run, 'systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
    const user = userInfo().username;
    // Linger is on exactly when systemd's marker file exists; reading it needs no session.
    if (!existsSync(join(options.lingerRoot ?? '/var/lib/systemd/linger', user))) {
      if (flags.has('--enable-linger')) {
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
  if (serviceRunning(manager, home, run)) {
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
  const run = options.run ?? defaultServiceRun;
  const path = servicePath(manager, home);
  if (!existsSync(path)) throw new CliInputError('No service file yet: run mama service install');
  if (manager === 'launchd') {
    const service = launchdService();
    if (service.pid !== null) {
      write('already running');
      return 0;
    }
    // A clean exit leaves the agent loaded with no process; it is started in place.
    if (service.loaded) {
      check(run, 'launchctl', ['kickstart', `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
    } else {
      check(run, 'launchctl', ['bootstrap', `gui/${process.getuid!()}`, path]);
    }
  } else {
    check(run, 'systemctl', ['--user', 'start', SYSTEMD_UNIT]);
  }
  write('started; mama status shows its boot');
  return 0;
}

export async function uninstallService(options: ServiceOptions = {}): Promise<number> {
  const home = options.home ?? homedir();
  const manager = managerFor(options.platform ?? process.platform);
  const write = options.write ?? ((line: string) => console.log(line));
  const run = options.run ?? defaultServiceRun;
  const path = servicePath(manager, home);
  if (manager === 'launchd') {
    const loaded = launchdService().loaded;
    if (!existsSync(path) && !loaded) {
      write('no LaunchAgent is installed');
      return 0;
    }
    if (loaded) {
      // mama stop unloads the agent and waits for its daemon to let go of the install.
      const stopped = await runStop([], options);
      if (stopped !== 0) return stopped;
    }
  } else {
    if (!existsSync(path)) {
      write('no systemd user unit is installed');
      return 0;
    }
    check(run, 'systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
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
    const manager = managerFor(options.platform ?? process.platform);
    if (!existsSync(servicePath(manager, options.home ?? homedir()))) {
      throw new CliInputError('No service file yet: run mama service install');
    }
    const stopped = await runStop([], options);
    return stopped === 0 ? await startService(options) : stopped;
  }
  if (command === 'status') return await runStatus([], options);
  if (command === 'uninstall') return await uninstallService(options);
  throw new CliInputError('Usage: mama service install|start|stop|restart|status|uninstall');
}
