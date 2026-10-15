import { accessSync, constants } from 'node:fs';
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

/** The first comment line of every start.sh that mama writes. */
export const START_SCRIPT_MARKER =
  '# Written by mama init or mama service install; mama service install rewrites it.';

export function startScript(options: {
  home: string;
  nodePath: string;
  cliPath: string;
  executablePaths: string[];
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
    'set -a',
    `. ${shellQuote(join(root, 'auth.env'))}`,
    'set +a',
    `export MAMA_LOG_LEVEL=${shellQuote(options.logLevel.toUpperCase())}`,
    ...Object.entries(options.viewer).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    ...(options.carried ?? []),
    `exec ${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)} daemon >> ${shellQuote(join(root, 'logs', 'daemon.log'))} 2>&1`,
    '',
  ].join('\n');
}

/** The PATH a generated start.sh sets: Node's folder, the tools' folders, then the system's. */
export function startPathEntries(options: {
  nodePath: string;
  executablePaths: string[];
}): string[] {
  return [
    ...new Set([
      dirname(options.nodePath),
      ...options.executablePaths.map(dirname),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]),
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
  <key>StandardOutPath</key><string>${xml(join(root, 'logs', 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(root, 'logs', 'daemon.log'))}</string>
</dict></plist>
`;
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
}

const GENERATED_STRUCTURE = [
  /^#/,
  /^set -eu$/,
  /^set -a$/,
  /^set \+a$/,
  /^umask 077$/,
  /^cd '/,
  /^\. '/,
];

export function readStartScript(script: string): StartScriptReading {
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
    if (GENERATED_STRUCTURE.some((pattern) => pattern.test(line))) continue;
    notReproduced.push(line);
  }
  return {
    generated: script.includes(START_SCRIPT_MARKER),
    carried,
    path,
    logLevel,
    exec,
    notReproduced,
  };
}
