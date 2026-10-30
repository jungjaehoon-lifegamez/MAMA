/**
 * install/install.sh, run whole as `curl ... | sh` runs it, under a temporary HOME. Stand-ins
 * first on PATH answer `uname`, `id`, `sudo`, `curl` and the backend; the rows "skips Node" and
 * "skips the package" of the run table let a seeded managed Node and npm stand in for the real
 * ones, so nothing is downloaded. The real download, npm install and vendor installers are the
 * CI leg's (scripts/install-check/run.mjs).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  env: Record<string, string> = {},
  text: string | Buffer = readFileSync(script)
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
    child.stdin.end(text);
  });
}

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
const root = () => join(home, '.mama');
const cli = () =>
  join(root(), 'npm', 'lib', 'node_modules', '@jungjaehoon', 'mama-os', 'dist', 'cli', 'index.js');

/**
 * A Node folder: `bin/node --version` prints the version; any other run is logged with it, and
 * exits $FAKE_NODE_STATUS (0 by default).
 */
function fakeNode(folder: string, nodeVersion: string): void {
  const bin = join(folder, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/bin/sh',
      `[ "$1" = --version ] && { echo v${nodeVersion}; exit 0; }`,
      `echo "node v${nodeVersion} $*" >> "$STUB_LOG"`,
      'exit "${FAKE_NODE_STATUS:-0}"',
      '',
    ].join('\n')
  );
  chmodSync(join(bin, 'node'), 0o755);
}

/** The managed Node and MAMA OS a finished install left: the script skips both. */
function seedInstall(nodeVersion = pin.version): void {
  const bin = join(root(), 'node', 'bin');
  fakeNode(join(root(), 'node'), nodeVersion);
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

  /**
   * The script with its darwin-arm64 hash set to a stand-in Node.js tarball's, and a curl that
   * serves that tarball: the hash check and the unpack run as written.
   */
  function servedNode(): Buffer {
    const tree = `${home}-tarball`;
    fakeNode(join(tree, `node-v${pin.version}-darwin-arm64`), pin.version);
    const tarball = `${tree}.tar.gz`;
    execFileSync('tar', ['-czf', tarball, '-C', tree, `node-v${pin.version}-darwin-arm64`]);
    rmSync(tree, { recursive: true });
    const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    stub(
      'curl',
      [
        'echo "curl $*" >> "$STUB_LOG"',
        'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done',
        `cp '${tarball}' "$out"`,
      ].join('\n')
    );
    return Buffer.from(
      readFileSync(script, 'utf8').replace(
        /^ {2}NODE_SHA256_DARWIN_ARM64=[0-9a-f]+$/m,
        `  NODE_SHA256_DARWIN_ARM64=${hash}`
      )
    );
  }

  it('moves the Node a set-up install runs to the pin through mama update --node', async () => {
    seedInstall('22.0.0');
    writeFileSync(join(root(), 'config.yaml'), 'version: 1\n');
    writeFileSync(join(root(), 'start.sh'), '#!/bin/sh\n');
    const text = servedNode();
    const result = await run(['--backend', 'codex', '--no-init'], {}, text);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      `MAMA runs Node.js 22.0.0 from ${join(root(), 'node')}; this installer pins ${pin.version}, so it moves MAMA to it.`
    );
    // Run on the Node it moves away from, with the hash-checked new one staged beside it.
    expect(calls()).toContain(`node v22.0.0 ${cli()} update --node ${join(root(), 'node.new')}`);
    expect(
      readFileSync(join(root(), 'node.new', 'bin', 'node'), 'utf8').includes(`v${pin.version}`)
    ).toBe(true);
    expect(calls().filter((call) => call.startsWith('npm install'))).toEqual([]);

    // A move that does not finish stops the script; the move's own report is above it.
    const failed = await run(['--backend', 'codex', '--no-init'], { FAKE_NODE_STATUS: '1' }, text);
    expect(failed.status).toBe(1);
    expect(failed.output).toContain(
      `moving MAMA to Node.js ${pin.version} did not finish (mama update --node's report is above)`
    );
  });

  it('replaces the Node of a setup with no service yet, as a fresh install does', async () => {
    seedInstall('22.0.0');
    writeFileSync(join(root(), 'config.yaml'), 'version: 1\n');
    const result = await run(['--backend', 'codex', '--no-init'], {}, servedNode());
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`Node.js ${pin.version} installed: ${join(root(), 'node')}`);
    expect(calls().filter((call) => call.includes('update --node'))).toEqual([]);
    expect(existsSync(join(root(), 'node.new'))).toBe(false);
  });

  /** A journal as mama update --node writes it, one field per line. */
  function moveJournal(phase: 'prepare' | 'committed', step: number): void {
    mkdirSync(join(root(), 'runtime'), { recursive: true });
    writeFileSync(
      join(root(), 'runtime', 'node-move.json'),
      `${JSON.stringify(
        {
          format: 'mama-node-move',
          phase,
          step,
          from: pin.version,
          to: '24.11.0',
          major: true,
          startedAt: '2026-10-30T00:00:00.000Z',
        },
        null,
        2
      )}\n`
    );
  }
  const nodeAt = (folder: string) =>
    /echo v(\S+);/.exec(readFileSync(join(root(), folder, 'bin', 'node'), 'utf8'))?.[1];

  it('finishes a move that had taken effect: the old folders go, and the run goes on', async () => {
    seedInstall();
    fakeNode(join(root(), 'node.old'), '22.0.0');
    mkdirSync(join(root(), 'npm.old'));
    moveJournal('committed', 4);
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "The managed Node's move to 24.11.0 had taken effect; its old folders are removed."
    );
    expect(readdirSync(root()).sort()).toEqual(['bin', 'node', 'npm', 'runtime']);
    expect(readdirSync(join(root(), 'runtime'))).toEqual([]);
  });

  it.each([
    // [what the killed run had done, folders beside node and npm, whether the hold is in place]
    // MAMA on the new Node is stopped first only without the hold: with it nothing was started,
    // and the new Node may sit beside the old prefix, which it cannot load.
    ['all four renames, waiting for the boot', ['node.old', 'npm.old'], false],
    ['all four renames, before the boot', ['node.old', 'npm.old'], true],
    ['the first rename only', ['node.old', 'node.new'], true],
    ['two renames: the new Node beside the old prefix', ['node.old'], true],
    [
      'three renames: npm is set aside, its copy not in place',
      ['node.old', 'npm.old', 'npm.new'],
      true,
    ],
    ['nothing yet: the copy only', ['node.new', 'npm.new'], false],
  ] as const)(
    'undoes a move cut off after %s, starts the old Node, and says to run it again',
    async (_label, beside, held) => {
      const stops = !held && beside.includes('node.old');
      seedInstall('24.11.0');
      // The folders as that run left them: the old Node set aside, the new one where it got to.
      if (beside.includes('node.old')) fakeNode(join(root(), 'node.old'), pin.version);
      if (beside.includes('node.new')) {
        rmSync(join(root(), 'node.new'), { recursive: true, force: true });
        if (beside.includes('node.old')) {
          // Between the first two renames: no ~/.mama/node at all.
          execFileSync('mv', [join(root(), 'node'), join(root(), 'node.new')]);
        } else {
          fakeNode(join(root(), 'node.new'), '24.11.0');
          rmSync(join(root(), 'node'), { recursive: true });
          fakeNode(join(root(), 'node'), pin.version);
        }
      }
      if (beside.includes('npm.old')) {
        // The old prefix set aside (marked), and its rebuilt copy in place or not yet.
        execFileSync('cp', ['-R', join(root(), 'npm'), join(root(), 'npm.old')]);
        writeFileSync(join(root(), 'npm.old', 'old'), '');
        if (beside.includes('npm.new')) {
          execFileSync('mv', [join(root(), 'npm'), join(root(), 'npm.new')]);
        }
      } else if (beside.includes('npm.new')) {
        execFileSync('cp', ['-R', join(root(), 'npm'), join(root(), 'npm.new')]);
      }
      moveJournal('prepare', beside.includes('node.old') ? 3 : 2);
      if (held) writeFileSync(join(root(), 'runtime', 'update.hold'), '1\n');
      const result = await run(['--backend', 'codex', '--no-init']);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `the move of the managed Node from ${pin.version} to 24.11.0 was cut off, and is undone: MAMA runs on Node.js ${pin.version} again. Run this installer again to move it.`
      );
      expect(nodeAt('node')).toBe(pin.version);
      expect(readdirSync(root()).sort()).toEqual(['node', 'npm', 'runtime']);
      if (beside.includes('npm.old')) expect(existsSync(join(root(), 'npm', 'old'))).toBe(true);
      expect(readdirSync(join(root(), 'runtime'))).toEqual([]);
      expect(calls().filter((call) => call.startsWith('node '))).toEqual([
        ...(stops ? [`node v24.11.0 ${cli()} stop`] : []),
        `node v${pin.version} ${cli()} service start`,
      ]);
    }
  );

  it('holds its own renames: cut midway, the next run stops nothing and finishes the undo', async () => {
    // A major move killed while MAMA booted on 24: every rename done, no hold.
    seedInstall('24.11.0');
    fakeNode(join(root(), 'node.old'), pin.version);
    execFileSync('cp', ['-R', join(root(), 'npm'), join(root(), 'npm.old')]);
    writeFileSync(join(root(), 'npm.old', 'old'), '');
    moveJournal('prepare', 4);
    // The recovery is cut (SIGKILL) as it puts the old prefix back.
    stub(
      'mv',
      `case "$1" in *npm.old) echo "cut" >> "$STUB_LOG"; kill -9 $PPID; exit 1 ;; esac; exec /bin/mv "$@"`
    );
    const cut = await run(['--backend', 'codex', '--no-init']);
    expect(cut.status).not.toBe(0);
    // Old Node back, the new prefix gone, the old one beside: the hold is what says so.
    expect(nodeAt('node')).toBe(pin.version);
    expect(existsSync(join(root(), 'npm'))).toBe(false);
    expect(existsSync(join(root(), 'runtime', 'update.hold'))).toBe(true);
    rmSync(join(stubs, 'mv'));
    const before = calls().length;
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('was cut off, and is undone');
    expect(existsSync(join(root(), 'npm', 'old'))).toBe(true);
    expect(readdirSync(root()).sort()).toEqual(['node', 'npm', 'runtime']);
    // No command ran on a Node beside a prefix of another ABI.
    expect(
      calls()
        .slice(before)
        .filter((call) => call.startsWith('node '))
    ).toEqual([`node v${pin.version} ${cli()} service start`]);
  });

  it('refuses an unheld move whose Node or command cannot run, changing nothing', async () => {
    seedInstall('24.11.0');
    fakeNode(join(root(), 'node.old'), pin.version);
    rmSync(cli());
    moveJournal('prepare', 4);
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('with no hold file and no runnable');
    expect(existsSync(join(root(), 'node.old'))).toBe(true);
    expect(existsSync(join(root(), 'runtime', 'update.hold'))).toBe(false);
    expect(calls().filter((call) => call.startsWith('node '))).toEqual([]);
  });

  it('leaves a move alone while the process holding update.lock still runs', async () => {
    seedInstall();
    moveJournal('prepare', 3);
    fakeNode(join(root(), 'node.old'), '22.0.0');
    writeFileSync(
      join(root(), 'runtime', 'update.holder.json'),
      `${JSON.stringify({ pid: process.pid, command: 'update --node', startedAt: 1, nonce: 'n' })}\n`
    );
    const result = await run(['--backend', 'codex', '--no-init']);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      `a move of the managed Node or an update runs now (pid ${process.pid}`
    );
    expect(existsSync(join(root(), 'node.old'))).toBe(true);
    expect(existsSync(join(root(), 'runtime', 'node-move.json'))).toBe(true);
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
