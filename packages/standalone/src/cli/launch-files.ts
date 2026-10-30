import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { shellQuote } from './secrets.js';

export function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return undefined;
}

/**
 * A Node path that survives an upgrade. Homebrew removes a version's Cellar folder when it
 * upgrades, but keeps `<prefix>/opt/<formula>` (and `<prefix>/bin/node` for `node`) pointing at
 * the current one, so the launch files use those when the running Node lives in the Cellar.
 */
export function stableNodePath(
  execPath: string,
  exists: (path: string) => boolean = existsSync
): string {
  const brew = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!brew) return execPath;
  const [, prefix, formula] = brew;
  const candidates = [
    join(prefix, 'opt', formula, 'bin', 'node'),
    ...(formula === 'node' ? [join(prefix, 'bin', 'node')] : []),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? execPath;
}

/** A Node path that a version manager or an upgrade removes (I6). */
export function versionedNodePath(path: string): boolean {
  return /\/Cellar\/node(@\d+)?\/|\/\.nvm\/versions\/node\/|\/\.volta\/tools\/image\/node\/|\/fnm\/node-versions\//.test(
    path
  );
}

/** The first comment line of every start.sh that mama writes. */
export const START_SCRIPT_MARKER =
  '# Written by mama init or mama service install; mama service install rewrites it.';

/**
 * While `mama update` swaps or rolls back the package, start.sh exits at once and cleanly, so a
 * service manager (or a reboot) starts nothing on a half-switched install and does not restart it
 * (docs/development/work/update.md, steps 8 and 13). Relative to the `cd` before it.
 */
export const UPDATE_HOLD_LINE = '[ -f runtime/update.hold ] && exit 0';

export function startScript(options: {
  home: string;
  nodePath: string;
  cliPath: string;
  executablePaths: string[];
  /** Tests name which tool folders exist; by default the ones on this machine. */
  exists?: (path: string) => boolean;
  viewer: Record<string, string>;
  /** config.yaml's logging.level; the core logger reads it only from MAMA_LOG_LEVEL. */
  logLevel: string;
  /** `export` lines carried over verbatim from the script being replaced. */
  carried?: readonly string[];
}): string {
  const root = join(options.home, '.mama');
  return [
    '#!/bin/sh',
    START_SCRIPT_MARKER,
    'set -eu',
    'umask 077',
    `export PATH=${shellQuote(startPathEntries(options).join(':'))}`,
    `cd ${shellQuote(root)}`,
    UPDATE_HOLD_LINE,
    'set -a',
    `. ${shellQuote(join(root, 'auth.env'))}`,
    'set +a',
    `export MAMA_LOG_LEVEL=${shellQuote(options.logLevel.toUpperCase())}`,
    ...Object.entries(options.viewer).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    ...(options.carried ?? []),
    ...crashLogLines(root),
    `exec ${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)} daemon >> "$crash" 2>&1`,
    '',
  ].join('\n');
}

/**
 * Where a package manager installs the owner's command-line tools: Homebrew on Apple silicon
 * (/opt/homebrew) and on Intel Macs and most Linux installs (/usr/local). The agent's shell runs
 * those tools (python3 with its packages, sqlite3) and expects them ahead of the system's own, as
 * in the owner's terminal.
 */
export const TOOL_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'];

/**
 * The PATH a generated start.sh sets: Node's folder, the backend's and gws's, the package
 * manager's folders that exist on this machine, then the system's.
 */
export function startPathEntries(options: {
  nodePath: string;
  executablePaths: string[];
  /** Tests name what exists; by default the folders on this machine. */
  exists?: (path: string) => boolean;
}): string[] {
  const exists = options.exists ?? existsSync;
  const system = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  // A Node or backend in a system folder (/usr/bin/node on Linux) keeps the system's place, after
  // the tool folders; start.sh runs Node by its full path either way.
  const own = [dirname(options.nodePath), ...options.executablePaths.map(dirname)].filter(
    (directory) => !system.includes(directory)
  );
  return [
    ...new Set([...own, ...TOOL_DIRECTORIES.filter((directory) => exists(directory)), ...system]),
  ];
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * What the service manager captures before the daemon writes its own rotated log (daemon.log):
 * start.sh's own messages, a crash while Node loads, a fatal error, a native library's writes.
 */
export const CRASH_LOG_NAME = 'crash.log';
/** start.sh empties the crash log at start once it is past this size. */
export const CRASH_LOG_CAP_BYTES = 1024 * 1024;

/**
 * start.sh's crash log: only what comes before the daemon takes over its own output lands there;
 * it is made owner-only and emptied at start once past the cap.
 */
function crashLogLines(root: string): string[] {
  return [
    `crash=${shellQuote(join(root, 'logs', CRASH_LOG_NAME))}`,
    // launchd creates the file it redirects to before this script's umask applies.
    `if [ -f "$crash" ]; then chmod 600 "$crash"; fi`,
    `if [ -f "$crash" ] && [ "$(wc -c < "$crash")" -gt ${CRASH_LOG_CAP_BYTES} ]; then : > "$crash"; fi`,
  ];
}

/** Seconds a service manager waits for a stopping daemon before it kills it. */
export const SERVICE_STOP_SECONDS = 60;

/**
 * The LaunchAgent restarts the daemon only after a failure: a clean exit (a stop, or a refusal
 * because another process holds the install) leaves it stopped.
 */
export function launchAgent(home: string): string {
  const root = join(home, '.mama');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mama.server</string>
  <key>ProgramArguments</key><array><string>${xml(join(root, 'start.sh'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>${SERVICE_STOP_SECONDS}</integer>
  <key>StandardOutPath</key><string>${xml(join(root, 'logs', CRASH_LOG_NAME))}</string>
  <key>StandardErrorPath</key><string>${xml(join(root, 'logs', CRASH_LOG_NAME))}</string>
</dict></plist>
`;
}

/** The update job /update starts (docs/development/work/update.md, PR 4). */
export const UPDATE_JOB_LABEL = 'com.mama.update';

/**
 * The update job's LaunchAgent: launchd's own job, so stopping the daemon's service does not end
 * it (checks.md, W2.3 Step 0). It runs once: no KeepAlive, and it is loaded from runtime/, not
 * ~/Library/LaunchAgents, so a login does not start it again.
 */
export function updateAgent(home: string): string {
  const root = join(home, '.mama');
  const log = xml(join(root, 'logs', 'update.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${UPDATE_JOB_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(join(root, 'runtime', 'update.sh'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

/**
 * The update job's script: start.sh's PATH and `cd` and its pinned Node and MAMA command, and
 * nothing of auth.env, so the job holds no credential; the progress sink reads the bot token
 * alone from auth.env when it sends. `MAMA_UPDATE_PROGRESS` reaches the new version's
 * `update --continue` and a rollback's CLI through the environment they inherit.
 */
export function updateScript(options: {
  home: string;
  /** start.sh's text. */
  start: string;
  nodePath: string;
  cliPath: string;
}): string {
  const root = join(options.home, '.mama');
  const reading = readStartScript(options.start, options.home);
  if (reading.path === null)
    throw new Error('start.sh sets no PATH; mama service install rewrites it');
  const log = join('logs', 'update.log');
  return [
    '#!/bin/sh',
    "# Written by MAMA's /update for the update job it starts; each /update rewrites it.",
    'set -eu',
    'umask 077',
    `export PATH=${reading.path}`,
    `cd ${shellQuote(root)}`,
    // launchd creates the file it redirects to before this script's umask applies.
    `if [ -f ${log} ]; then chmod 600 ${log}; fi`,
    'export MAMA_UPDATE_PROGRESS=telegram',
    `exec ${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)} update`,
    '',
  ].join('\n');
}

/**
 * The systemd user unit, with the same restart policy as the LaunchAgent. `%h` is the home folder,
 * expanded by systemd per argument, so a path with spaces stays one argument. KillMode=mixed sends
 * the stop signal to the daemon alone, which stops its children in order; anything left is killed
 * when the stop times out.
 */
export function systemdUnit(): string {
  return [
    '[Unit]',
    'Description=MAMA OS daemon',
    '',
    '[Service]',
    'Type=simple',
    'WorkingDirectory=%h/.mama',
    'ExecStart="%h/.mama/start.sh"',
    'Restart=on-failure',
    'RestartSec=10',
    `TimeoutStopSec=${SERVICE_STOP_SECONDS}`,
    'KillMode=mixed',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** What an existing start.sh holds that a regenerated one would or would not reproduce. */
export interface StartScriptReading {
  /** Written by mama (it carries the marker line). */
  readonly generated: boolean;
  /** `export` lines kept verbatim, except PATH and MAMA_LOG_LEVEL, which are written anew. */
  readonly carried: string[];
  readonly path: string | null;
  readonly logLevel: string | null;
  readonly exec: string | null;
  /** Other lines with an effect (assignments, commands) that the new script does not have. */
  readonly notReproduced: string[];
  /** It sources this install's auth.env with the generated line. */
  readonly loadsAuthEnv: boolean;
}

/**
 * Split a start.sh line into words as sh does before expansion: a `#` starting a word ends the
 * line, single quotes are literal, double
 * quotes keep their text (a backslash escapes `"`, `\\`, `$` and a backtick), and a backslash
 * outside quotes escapes the next character. Variables stay as written.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw new Error('unterminated single quote');
      word = (word ?? '') + line.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      let text = '';
      index += 1;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === '\\' && '"\\$`'.includes(line[index + 1] ?? '')) index += 1;
        text += line[index];
        index += 1;
      }
      if (index >= line.length) throw new Error('unterminated double quote');
      word = (word ?? '') + text;
    } else if (char === '\\') {
      word = (word ?? '') + (line[index + 1] ?? '');
      index += 1;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === '#' && word === null) {
      // A # that starts a word starts a comment.
      break;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The PATH entries an `export PATH=` value names, with `$HOME` and `~` read as `home`. */
export function startPathValue(value: string, home: string): string[] {
  return (shellWords(value)[0] ?? '')
    .split(':')
    .map((entry) => entry.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/|$)/, home))
    .filter((entry) => entry !== '' && entry !== '$PATH' && entry !== '${PATH}');
}

/** The values a start.sh's carried `export` lines set, unquoted. */
export function startExports(reading: StartScriptReading): Record<string, string> {
  return Object.fromEntries(
    reading.carried.flatMap((line) => {
      const match = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      return match ? [[match[1], shellWords(match[2])[0] ?? '']] : [];
    })
  );
}

/**
 * Read a start.sh against what this install's generated one holds. Only exact generated lines
 * count as reproduced: a changed `cd` or a different sourced file is reported, not dropped.
 */
export function readStartScript(script: string, home: string): StartScriptReading {
  const root = join(home, '.mama');
  const generatedLines = new Set([
    'set -eu',
    'set -a',
    'set +a',
    'umask 077',
    `cd ${shellQuote(root)}`,
    UPDATE_HOLD_LINE,
    `. ${shellQuote(join(root, 'auth.env'))}`,
    ...crashLogLines(root),
  ]);
  const carried: string[] = [];
  const notReproduced: string[] = [];
  let path: string | null = null;
  let logLevel: string | null = null;
  let exec: string | null = null;
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const exported = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (exported) {
      if (exported[1] === 'PATH') path = exported[2];
      else if (exported[1] === 'MAMA_LOG_LEVEL') logLevel = exported[2];
      else carried.push(line);
      continue;
    }
    if (/^exec\s/.test(line)) {
      exec = line;
      continue;
    }
    if (line.startsWith('#') || generatedLines.has(line)) continue;
    notReproduced.push(line);
  }
  const authLine = `. ${shellQuote(join(root, 'auth.env'))}`;
  return {
    generated: script.includes(START_SCRIPT_MARKER),
    loadsAuthEnv: script.split('\n').some((line) => line.trim() === authLine),
    carried,
    path,
    logLevel,
    exec,
    notReproduced,
  };
}
