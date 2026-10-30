/**
 * install/install.sh, run whole as `curl ... | sh` runs it, under a temporary HOME. Stand-ins
 * first on PATH answer `uname`, `id`, `sudo`, `curl` and the backend; the rows "skips Node" and
 * "skips the package" of the run table let a seeded managed Node and npm stand in for the real
 * ones, so nothing is downloaded. The real download, npm install and vendor installers are the
 * CI leg's (scripts/install-check/run.mjs).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRoots } from '../../src/cli/runtime/default-roots.js';

const standalone = join(__dirname, '..', '..');
const script = join(standalone, 'install', 'install.sh');
const pin = JSON.parse(readFileSync(join(standalone, 'install', 'node.json'), 'utf8')) as {
  version: string;
  sha256: Record<string, string>;
};
const version = (
  JSON.parse(readFileSync(join(standalone, 'package.json'), 'utf8')) as { version: string }
).version;

let home: string;
let stubs: string;
let log: string;

function stub(name: string, body: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
}

/** The script on stdin, in its own session (no terminal), with the stand-ins first on PATH. */
function run(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s', '--', ...args], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: home,
        PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
        SHELL: '/bin/zsh',
        FAKE_UNAME_S: 'Darwin',
        FAKE_UNAME_M: 'arm64',
        FAKE_USER: 'fixture',
        FAKE_SUDO_STATUS: '0',
        STUB_LOG: log,
        ...env,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
    child.stdin.end(readFileSync(script));
  });
}

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
const root = () => join(home, '.mama');
const cli = () =>
  join(root(), 'npm', 'lib', 'node_modules', '@jungjaehoon', 'mama-os', 'dist', 'cli', 'index.js');

/** The managed Node and MAMA OS a finished install left: the script skips both. */
function seedInstall(nodeVersion = pin.version): void {
  const bin = join(root(), 'node', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), `#!/bin/sh\n[ "$1" = --version ] && echo v${nodeVersion}\n`);
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      'echo "npm $*" >> "$STUB_LOG"',
      'case "$1" in',
      `  ls) echo "$HOME/.mama/npm/lib/node_modules/@jungjaehoon/mama-os:@jungjaehoon/mama-os@${version}" ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  mkdirSync(join(cli(), '..'), { recursive: true });
  writeFileSync(join(cli(), '..', '..', '..', 'package.json'), `{"version":"${version}"}\n`);
  writeFileSync(cli(), '');
}

const block = (localBin = false) =>
  [
    '# >>> mama >>>',
    '# Written by the MAMA OS installer; each run rewrites the lines between these markers.',
    `export PATH="$HOME/.mama/bin:${localBin ? '$HOME/.local/bin:' : ''}$PATH"`,
    '# <<< mama <<<',
  ].join('\n');

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mama-install-sh-')));
  stubs = `${home}-stubs`;
  log = `${home}-calls.log`;
  mkdirSync(stubs);
  stub('uname', 'case "$1" in -s) echo "$FAKE_UNAME_S" ;; -m) echo "$FAKE_UNAME_M" ;; esac');
  stub('id', '[ "$1" = -un ] && { echo "$FAKE_USER"; exit 0; }; exec /usr/bin/id "$@"');
  stub('sudo', 'echo "sudo $*" >> "$STUB_LOG"; exit "$FAKE_SUDO_STATUS"');
  stub('codex', 'echo "codex $*" >> "$STUB_LOG"');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(stubs, { recursive: true, force: true });
  rmSync(log, { force: true });
});

describe('install.sh', () => {
  it('writes the wrapper and the zsh block, and a second run changes neither', async () => {
    seedInstall();
    const first = await run(['--backend', 'codex', '--no-init']);
    expect(first.status, first.output).toBe(0);
    const wrapper = join(root(), 'bin', 'mama');
    expect(readFileSync(wrapper, 'utf8')).toBe(
      `#!/bin/sh\nexec '${join(root(), 'node', 'bin', 'node')}' '${cli()}' "$@"\n`
    );
    expect(statSync(wrapper).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(`${block()}\n`);
    expect(first.output).toContain(`Node.js ${pin.version} is in place`);
    expect(first.output).toContain(`MAMA OS ${version} is in place`);
    expect(first.output).toContain('mama init');
    // npm is asked only what it holds; nothing is installed and the backend is not run.
    expect(calls().every((call) => call.startsWith('npm ls -g --prefix'))).toBe(true);

    const before = [wrapper, join(home, '.zshrc')].map((path) => statSync(path).mtimeMs);
    const second = await run(['--backend', 'codex', '--no-init']);
    expect(second.status, second.output).toBe(0);
    expect([wrapper, join(home, '.zshrc')].map((path) => statSync(path).mtimeMs)).toEqual(before);
  });

  it('rewrites the block in place and keeps the lines around it', async () => {
    seedInstall();
    const rc = join(home, '.zshrc');
    writeFileSync(
      rc,
      ['before', '# >>> mama >>>', 'export PATH="/old:$PATH"', '# <<< mama <<<', 'after', ''].join(
        '\n'
      )
    );
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(rc, 'utf8')).toBe(`before\n${block()}\nafter\n`);
  });

  it('appends the block after a blank line to a startup file without one', async () => {
    seedInstall();
    writeFileSync(join(home, '.zshrc'), 'alias ll="ls -l"\n');
    expect((await run(['--backend', 'codex', '--no-init'])).status).toBe(0);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(`alias ll="ls -l"\n\n${block()}\n`);
  });

  it('names ~/.local/bin when the backend lives there', async () => {
    seedInstall();
    rmSync(join(stubs, 'codex'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'codex'), '#!/bin/sh\n');
    chmodSync(join(home, '.local', 'bin', 'codex'), 0o755);
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`codex is installed: ${join(home, '.local', 'bin', 'codex')}`);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(`${block(true)}\n`);
  });

  it.each([
    ['bash on Linux', '/bin/bash', 'Linux', [], '.bashrc'],
    ['bash on macOS', '/bin/bash', 'Darwin', [], '.bash_profile'],
    ['bash on macOS with only ~/.profile', '/bin/bash', 'Darwin', ['.profile'], '.profile'],
    [
      'bash on macOS with both',
      '/bin/bash',
      'Darwin',
      ['.profile', '.bash_profile'],
      '.bash_profile',
    ],
    ['another shell', '/bin/dash', 'Linux', [], '.profile'],
  ])('%s: the block goes in %s', async (_label, shell, platform, existing, expected) => {
    seedInstall();
    for (const name of existing) writeFileSync(join(home, name), '# mine\n');
    const result = await run(['--backend', 'codex', '--no-init'], {
      SHELL: shell,
      FAKE_UNAME_S: platform,
    });
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(join(home, expected), 'utf8')).toContain(block());
    for (const name of ['.zshrc', '.bashrc', '.bash_profile', '.profile'].filter(
      (name) => name !== expected
    ))
      expect(
        existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8') : ''
      ).not.toContain('# >>> mama >>>');
  });

  it('fish: prints the fish_add_path line and writes no startup file', async () => {
    seedInstall();
    const result = await run(['--backend', 'codex', '--no-init'], { SHELL: '/usr/bin/fish' });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`In fish, run once: fish_add_path ${join(root(), 'bin')}`);
    expect(result.output).not.toContain('Open a new terminal');
    expect(readdirSync(home).sort()).toEqual(['.mama']);
  });

  it('zsh with ZDOTDIR: the block goes in $ZDOTDIR/.zshrc', async () => {
    seedInstall();
    const zdotdir = join(home, '.config', 'zsh');
    mkdirSync(zdotdir, { recursive: true });
    const result = await run(['--backend', 'codex', '--no-init'], { ZDOTDIR: zdotdir });
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(join(zdotdir, '.zshrc'), 'utf8')).toBe(`${block()}\n`);
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
  });

  it('a read-only startup file is refused with exit 1 and left as it was', async () => {
    seedInstall();
    const rc = join(home, '.zshrc');
    writeFileSync(rc, 'mine\n');
    chmodSync(rc, 0o444);
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`could not write ${rc}`);
    expect(result.output).not.toContain('Installed.');
    expect(readFileSync(rc, 'utf8')).toBe('mine\n');
    expect(statSync(rc).mode & 0o777).toBe(0o444);
    // The temporary file beside it is removed on the way out.
    expect(readdirSync(home).sort()).toEqual(['.mama', '.zshrc']);
  });

  it('a wrapper that cannot be written is refused with exit 1', async () => {
    seedInstall();
    mkdirSync(join(root(), 'bin'), { mode: 0o500 });
    const result = await run(['--backend', 'codex', '--no-init']);
    chmodSync(join(root(), 'bin'), 0o700);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`could not write ${join(root(), 'bin', 'mama')}`);
    expect(readdirSync(join(root(), 'bin'))).toEqual([]);
  });

  it('a startup file that is a link stays a link; its target gets the block', async () => {
    seedInstall();
    mkdirSync(join(home, 'dotfiles'));
    const target = join(home, 'dotfiles', 'zshrc');
    writeFileSync(target, 'mine\n');
    chmodSync(target, 0o644);
    symlinkSync('dotfiles/zshrc', join(home, '.zshrc'));
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(0);
    expect(lstatSync(join(home, '.zshrc')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(`mine\n\n${block()}\n`);
    // The mode is the file's own, not the installer's umask.
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('a startup file with CRLF line ends keeps one block across runs', async () => {
    seedInstall();
    const rc = join(home, '.zshrc');
    writeFileSync(rc, 'mine\r\n# >>> mama >>>\r\nexport PATH="/old:$PATH"\r\n# <<< mama <<<\r\n');
    expect((await run(['--backend', 'codex', '--no-init'])).status).toBe(0);
    const once = readFileSync(rc, 'utf8');
    expect(once).toBe(`mine\r\n${block()}\n`);
    expect((await run(['--backend', 'codex', '--no-init'])).status).toBe(0);
    expect(readFileSync(rc, 'utf8')).toBe(once);
  });

  it('removes what a killed run left beside the managed Node', async () => {
    seedInstall();
    mkdirSync(join(root(), 'node.4242.tmp'));
    writeFileSync(join(root(), 'node.4242.tar.gz'), 'partial');
    writeFileSync(join(root(), 'backend-install.4242.sh'), 'partial');
    expect((await run(['--backend', 'codex', '--no-init'])).status).toBe(0);
    expect(readdirSync(root()).sort()).toEqual(['bin', 'node', 'npm']);
  });

  it('refuses a startup file whose block has no end marker, changing nothing', async () => {
    seedInstall();
    const rc = join(home, '.zshrc');
    writeFileSync(rc, 'before\n# >>> mama >>>\nafter\n');
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('without its');
    expect(readFileSync(rc, 'utf8')).toBe('before\n# >>> mama >>>\nafter\n');
  });

  it('runs no sudo on macOS', async () => {
    seedInstall();
    expect((await run(['--backend', 'codex', '--no-init'])).status).toBe(0);
    expect(calls().filter((call) => call.startsWith('sudo'))).toEqual([]);
  });

  it('Linux: shows the one sudo call and runs it', async () => {
    seedInstall();
    const result = await run(['--backend', 'codex', '--no-init'], { FAKE_UNAME_S: 'Linux' });
    expect(result.status, result.output).toBe(0);
    const command =
      'umask 022; install -d -m 0755 /var/lib/mama; install -d -o fixture -m 0700 /var/lib/mama/fixture; loginctl enable-linger fixture';
    expect(result.output).toContain(`sudo sh -c '${command}'`);
    expect(calls().filter((call) => call.startsWith('sudo'))).toEqual([`sudo sh -c ${command}`]);
  });

  it('Linux: a refused sudo prints the command and goes on', async () => {
    seedInstall();
    const result = await run(['--backend', 'codex', '--no-init'], {
      FAKE_UNAME_S: 'Linux',
      FAKE_SUDO_STATUS: '1',
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('That did not run');
    expect(existsSync(join(root(), 'bin', 'mama'))).toBe(true);
  });

  it.each(['bad user', 'jürgen', '-dash'])(
    "Linux: the user name %j, outside the default folders' pattern, gets no sudo",
    async (user) => {
      // The pattern is default-roots.ts's: init offers no default folders for this name either.
      expect(defaultRoots({ platform: 'linux', user })).toBeUndefined();
      expect(defaultRoots({ platform: 'linux', user: 'fixture' })).toBeDefined();
      seedInstall();
      const result = await run(['--backend', 'codex', '--no-init'], {
        FAKE_UNAME_S: 'Linux',
        FAKE_USER: user,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('nothing is run with sudo');
      expect(calls().filter((call) => call.startsWith('sudo'))).toEqual([]);
    }
  );

  it('a Node download with another hash exits 1 and unpacks nothing', async () => {
    stub(
      'curl',
      [
        'echo "curl $*" >> "$STUB_LOG"',
        'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done',
        'echo "not node" > "$out"',
      ].join('\n')
    );
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(1);
    const [download, ...rest] = calls();
    expect(rest).toEqual([]);
    expect(download).toBe(
      `curl -fsSL -o ${root()}/node.${/node\.(\d+)\.tar\.gz/.exec(download)?.[1]}.tar.gz https://nodejs.org/dist/v${pin.version}/node-v${pin.version}-darwin-arm64.tar.gz`
    );
    // Both hashes are named.
    expect(result.output).toContain(pin.sha256['darwin-arm64']);
    expect(result.output).toMatch(/has SHA-256 [0-9a-f]{64}, not /);
    // The download is deleted, and nothing was unpacked or installed.
    expect(readdirSync(root())).toEqual([]);
  });

  it('refuses an account another install set up, before any change', async () => {
    mkdirSync(root());
    writeFileSync(join(root(), 'config.yaml'), 'version: 1\n');
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('mama update --dry-run');
    expect(readdirSync(root())).toEqual(['config.yaml']);
    expect(readdirSync(home)).toEqual(['.mama']);
  });

  it('leaves the Node of a set-up install alone when the pin differs', async () => {
    seedInstall('22.0.0');
    writeFileSync(join(root(), 'config.yaml'), 'version: 1\n');
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      `MAMA runs Node.js 22.0.0 from ${join(root(), 'node')}; this installer pins ${pin.version}`
    );
    expect(result.output).toContain('mama update updates it');
    expect(calls().filter((call) => call.startsWith('npm install'))).toEqual([]);
  });

  it('refuses an unfinished Node move, before any change', async () => {
    seedInstall();
    mkdirSync(join(root(), 'runtime'));
    writeFileSync(join(root(), 'runtime', 'node-move.json'), '{}\n');
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('node-move.json');
    expect(existsSync(join(root(), 'bin'))).toBe(false);
  });

  it('without a terminal needs --backend, and --non-interactive or --no-init', async () => {
    const asked = await run([]);
    expect(asked.status).toBe(1);
    expect(asked.output).toContain('pass --backend');
    const init = await run(['--backend', 'codex']);
    expect(init.status).toBe(1);
    expect(init.output).toContain('--non-interactive');
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses a platform other than macOS and Linux', async () => {
    const result = await run(['--backend', 'codex', '--no-init'], { FAKE_UNAME_S: 'FreeBSD' });
    expect(result.status).toBe(1);
    expect(result.output).toContain('this is FreeBSD');
    expect(readdirSync(home)).toEqual([]);
  });
});
