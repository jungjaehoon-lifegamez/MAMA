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

export function startScript(options: {
  home: string;
  nodePath: string;
  cliPath: string;
  executablePaths: string[];
  viewer: Record<string, string>;
}): string {
  const root = join(options.home, '.mama');
  const path = [
    ...new Set([
      dirname(options.nodePath),
      ...options.executablePaths.map(dirname),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]),
  ].join(':');
  return [
    '#!/bin/sh',
    'set -eu',
    'umask 077',
    `export PATH=${shellQuote(path)}`,
    `cd ${shellQuote(root)}`,
    'set -a',
    `. ${shellQuote(join(root, 'auth.env'))}`,
    'set +a',
    ...Object.entries(options.viewer).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `exec ${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)} daemon >> ${shellQuote(join(root, 'logs', 'daemon.log'))} 2>&1`,
    '',
  ].join('\n');
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

/** The systemd user unit, with the same restart policy as the LaunchAgent. */
export function systemdUnit(home: string): string {
  const root = join(home, '.mama');
  return [
    '[Unit]',
    'Description=MAMA OS daemon',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${root}`,
    `ExecStart=${join(root, 'start.sh')}`,
    'Restart=on-failure',
    'RestartSec=10',
    `TimeoutStopSec=${SERVICE_STOP_SECONDS}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Exported names the generated start.sh carries over from an existing one: the viewer's access. */
export const CARRIED_START_ENV = [
  'MAMA_CF_ACCESS_ISSUER',
  'MAMA_CF_ACCESS_AUD',
  'MAMA_VIEWER_HOSTNAMES',
  'MAMA_VIEWER_OWNER_EMAILS',
  'MAMA_API_HOST',
  'MAMA_API_PORT',
] as const;

/**
 * Read `export NAME=value` lines from an existing start.sh: the carried names with their values,
 * and the other exported names, which the new script does not keep.
 */
export function startScriptExports(script: string): {
  carried: Record<string, string>;
  dropped: string[];
} {
  const carried: Record<string, string> = {};
  const dropped: string[] = [];
  for (const line of script.split('\n')) {
    const match = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    if ((CARRIED_START_ENV as readonly string[]).includes(name)) {
      carried[name] = unquoteShell(raw.trim());
    } else if (name !== 'PATH' && !dropped.includes(name)) {
      dropped.push(name);
    }
  }
  return { carried, dropped };
}

/** The inverse of shellQuote for a single-quoted word; a bare word is taken as written. */
function unquoteShell(value: string): string {
  if (!value.startsWith("'")) return value.replace(/^"(.*)"$/, '$1');
  return value.slice(1, -1).replace(/'"'"'/g, "'");
}
