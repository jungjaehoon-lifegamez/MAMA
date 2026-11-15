import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backendEnvironment, normalizeReadPaths } from '../runtime/backend-security.js';
import { runCommand, type CommandRunner } from './command-runner.js';

export function requireOfficeSandbox(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error(
      `document.render requires a sandbox that enforces read denies and the network deny (sandbox-exec on macOS, bwrap on Linux); rendering is unavailable on ${platform}`
    );
}

/** Where the distributions MAMA supports install bubblewrap. */
export const LINUX_BWRAP = '/usr/bin/bwrap';

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * The Linux counterpart of officeSandboxProfile, as bwrap arguments (L1): the root read-only, no
 * network (LibreOffice's AF_UNIX socket stays inside the sandbox), a private empty /tmp, each
 * denied folder covered by an empty tmpfs and each denied file by /dev/null, and only the render's
 * folders writable. A denied path that does not exist, or that lies under /tmp or another denied
 * folder, is already hidden; bwrap cannot mount over a path that is not there.
 */
export function linuxSandboxArgs(
  temp: string,
  output: string,
  deniedReadPaths: readonly string[]
): string[] {
  const denied = [
    ...new Set(
      normalizeReadPaths(deniedReadPaths)
        .filter((path) => existsSync(path))
        .map((path) => realpathSync(path))
    ),
  ]
    .filter((path) => !within('/tmp', path) && !within('/run', path))
    .sort((a, b) => a.length - b.length);
  const covers: string[] = [];
  for (const path of denied) {
    if (covers.some((parent) => within(parent, path))) continue;
    covers.push(path);
  }
  return [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    // Pathname unix sockets (the D-Bus system and session buses, systemd's private socket, agent
    // sockets, docker.sock) live under /run; a read-only bind does not stop a connect, and through
    // the session bus a renderer could start a process outside the sandbox (review, measured on
    // Ubuntu 24.04: the system bus answered). /var/run is a link to /run on the hosts we run on.
    '--tmpfs',
    '/run',
    ...(existsSync('/var/run') && !lstatSync('/var/run').isSymbolicLink()
      ? ['--tmpfs', '/var/run']
      : []),
    ...covers.flatMap((path) =>
      lstatSync(path).isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path]
    ),
    ...[...new Set([temp, output])].flatMap((path) => ['--bind', path, path]),
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-pid',
    '--new-session',
    '--die-with-parent',
    '--chdir',
    temp,
  ];
}

/** Office needs an AF_UNIX bind in /tmp; that grants no outbound network. */
export function officeSandboxProfile(
  temp: string,
  output: string,
  deniedReadPaths: readonly string[]
): string {
  const quoted = (path: string) => JSON.stringify(path);
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network-bind network-inbound (local unix-socket))',
    '(deny appleevent-send)',
    '(deny file-write*)',
    // LibreOffice checks that /tmp is writable, then binds its single-instance socket there
    // (/tmp/OSL_PIPE_<uid>_SingleOfficeIPC_<hash>) whatever TMPDIR says; measured 2026-10-14.
    `(allow file-write* ${[temp, output].map((path) => `(subpath ${quoted(path)})`).join(' ')} (literal "/private/tmp") (regex #"^/private/tmp/OSL_PIPE_[0-9]+_SingleOfficeIPC_[0-9a-f]+$"))`,
    ...(deniedReadPaths.length
      ? [
          `(deny file-read* ${normalizeReadPaths(deniedReadPaths)
            .map((path) => `(subpath ${quoted(path)})`)
            .join(' ')})`,
        ]
      : []),
    // Every agent denies the host render root. Only this renderer may read its private child.
    `(allow file-read* (subpath ${quoted(temp)}))`,
    // LibreOffice stats that child's parent, the render root; denied, it waits until the timeout
    // (measured 2026-10-15). Metadata of the root alone lists no other render.
    `(allow file-read-metadata (literal ${quoted(dirname(temp))}))`,
  ].join('\n');
}

export function renderEnvironment(
  versionDir: string,
  fontconfig: string,
  temp: string
): NodeJS.ProcessEnv {
  // No address of a bus or agent outside the sandbox (review): their sockets are covered on Linux,
  // and a renderer has no use for them anywhere.
  const {
    DBUS_SESSION_BUS_ADDRESS: _bus,
    XDG_RUNTIME_DIR: _runtime,
    SSH_AUTH_SOCK: _agent,
    ...environment
  } = backendEnvironment();
  return {
    ...environment,
    HOME: temp,
    TMPDIR: temp,
    XDG_CACHE_HOME: join(temp, 'cache'),
    XDG_CONFIG_HOME: join(temp, 'config'),
    FONTCONFIG_FILE: fontconfig,
    FONTCONFIG_PATH: versionDir,
    // LibreOffice's bundled Python would write __pycache__ into the app and break its seal.
    PYTHONDONTWRITEBYTECODE: '1',
    PATH: `${join(versionDir, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
}

export async function sandboxedCommand(options: {
  command: string;
  args: string[];
  temp: string;
  output: string;
  deniedReadPaths: readonly string[];
  platform?: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  run?: CommandRunner;
}): ReturnType<CommandRunner> {
  requireOfficeSandbox(options.platform);
  const run = options.run ?? runCommand;
  if ((options.platform ?? process.platform) === 'linux')
    // An absolute path, as macOS names /usr/bin/sandbox-exec: a bare name would resolve through
    // the render environment's PATH, where another file named bwrap would run unsandboxed.
    return run(
      LINUX_BWRAP,
      [
        ...linuxSandboxArgs(options.temp, options.output, options.deniedReadPaths),
        '--',
        options.command,
        ...options.args,
      ],
      { env: options.env, cwd: options.temp, timeoutMs: options.timeoutMs }
    );
  return run(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      officeSandboxProfile(options.temp, options.output, options.deniedReadPaths),
      options.command,
      ...options.args,
    ],
    { env: options.env, cwd: options.temp, timeoutMs: options.timeoutMs }
  );
}

export async function renderOffice(options: {
  soffice: string;
  input: string;
  output: string;
  temp: string;
  env: NodeJS.ProcessEnv;
  deniedReadPaths: readonly string[];
  timeoutMs: number;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}): Promise<void> {
  const profile = join(options.temp, 'profile');
  mkdirSync(join(profile, 'user'), { recursive: true });
  writeFileSync(
    join(profile, 'user', 'registrymodifications.xcu'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
      '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">' +
      '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>' +
      '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>' +
      '<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>' +
      '</item>' +
      // Writer's Link: 2 is Never (1 is On Request); Calc's Link: 1 is Never.
      '<item oor:path="/org.openoffice.Office.Writer/Content/Update">' +
      '<prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>' +
      '<item oor:path="/org.openoffice.Office.Calc/Content/Update">' +
      '<prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>' +
      '</oor:items>\n',
    { mode: 0o600 }
  );
  await sandboxedCommand({
    ...options,
    command: options.soffice,
    args: [
      '--headless',
      '--nologo',
      '--nodefault',
      '--norestore',
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      options.output,
      options.input,
    ],
  });
}
