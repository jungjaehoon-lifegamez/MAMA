#!/usr/bin/env node
/**
 * The install command's leg (docs/development/work/install.md, PR 1, CI job `install-check`).
 * A local registry serves this build as N and N+1, and install/install.sh runs on a fresh HOME:
 *
 * 1. `install.sh --backend codex --no-init`, with npm's registry set to the local one and
 *    node-gyp set to /bin/false, so the prebuilt native binaries must cover this platform. Linux:
 *    the sudo call leaves /var/lib/mama 0755 and the user's folder 0700.
 * 2. The installed package's init under the managed Node (managed.mjs), which enters the bot
 *    token and the pairing code on its setup page, then
 *    `~/.mama/bin/mama service install` through the stand-in service manager with another Node
 *    first on PATH: start.sh names the managed Node, installKind is npm at ~/.mama/npm, doctor's
 *    Node check is ok, and `mama update N+1 --dry-run` shows N → N+1.
 * 3. A second run changes no file; a run on a finished install exits 0 at init's status; a run cut
 *    off after Node skips Node the next time; a truncated script runs nothing.
 * 4. With --vendor-installers (CI only): codex in step 1 and claude here come from their vendors'
 *    installers as the script runs them, with no terminal, at or above backend-probe.ts's minimums.
 *    Without it a stub codex is first on PATH, so the script finds a backend and installs none.
 * 5. The Node move (move.mjs, PR 2): the daemon booted on the managed Node, then the script run
 *    again with other pins: a patch move, the move back killed after each step and recovered, a
 *    Node that cannot boot MAMA put back, and a major move with its rebuilt prefix.
 * 6. A source's tool (PR 3): Gmail enabled without gws, doctor names the two commands; the first
 *    runs as printed, with no Node on PATH but the one it names, and installs the real
 *    @googleworkspace/cli from npmjs (its postinstall fetches the binary from GitHub); the
 *    second, `gws auth login`, needs a browser, so the same command runs `--version` and
 *    `auth --help` instead. Doctor then finds gws on the service's PATH.
 *
 * Run after `pnpm build`: node packages/standalone/scripts/install-check/run.mjs [--vendor-installers]
 * It downloads Node.js from nodejs.org twice (two fresh homes) and the dependencies through the
 * registry; the npm cache is the machine's.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NAME, freePort, serveThisBuild } from '../local-registry.mjs';
import { moveLeg } from './move.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const standalone = join(here, '..', '..');
const script = join(standalone, 'install', 'install.sh');
const pin = JSON.parse(readFileSync(join(standalone, 'install', 'node.json'), 'utf8'));
const N = JSON.parse(readFileSync(join(standalone, 'package.json'), 'utf8')).version;
const [major, minor, patch] = N.split('.').map(Number);
const N1 = `${major}.${minor}.${patch + 1}`;
const vendorInstallers = process.argv.includes('--vendor-installers');
const { probeBackend } = await import(
  pathToFileURL(join(standalone, 'dist', 'cli', 'runtime', 'backend-probe.js')).href
);

function expect(ok, message) {
  if (!ok) {
    throw new Error(`install check: ${message}`);
  }
}

/** install.sh as `curl ... | sh` runs it: the script on stdin, in its own session, so no terminal. */
function runScript(label, text, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s', '--', ...args], {
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      console.log(output.trimEnd().replace(/^/gm, `  ${label} | `));
      resolve({ status, output });
    });
    child.stdin.end(text);
  });
}

function capture(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 600_000 });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  console.log(output.trimEnd().replace(/^/gm, `  ${[command, ...args].join(' ')} | `));
  return { status: result.status, stdout: result.stdout ?? '', output };
}

/** Every entry under `dir`: type, mode, owner, size, modification time and content hash. */
function snapshot(dir) {
  const entries = {};
  const walk = (path) => {
    const stat = lstatSync(path);
    const entry = [stat.mode, stat.uid, stat.size, stat.mtimeMs];
    if (stat.isSymbolicLink()) {
      entry.push(readlinkSync(path));
    } else if (stat.isFile()) {
      entry.push(createHash('sha256').update(readFileSync(path)).digest('hex'));
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name));
      }
    }
    entries[path] = entry.join(' ');
  };
  walk(dir);
  return entries;
}

function sameSnapshot(before, after) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (path) => before[path] !== after[path]
  );
  return changed;
}

// Not os.tmpdir(): the control socket under the install must stay within a Unix socket's 104
// bytes. realpath: macOS's /tmp is a link, and the package's own paths are read through realpath.
const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP ?? '/tmp', 'mama-install-')));
const children = [];
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    for (const child of children) {
      child.kill();
    }
    rmSync(root, { recursive: true, force: true });
    process.exit(code);
  });
}

try {
  const text = readFileSync(script, 'utf8');
  const served = await serveThisBuild({
    dir: join(root, 'registry'),
    versions: [{ version: N }, { version: N1 }],
  });
  children.push(served.server);
  const { registry } = served;
  console.log(`install check: ${registry} serves ${NAME} ${N} and ${N1}`);

  // The stub backend: a supported version and a login, and no model. Without --vendor-installers
  // it is also what the script finds on PATH.
  const stubs = join(root, 'stub-backend');
  mkdirSync(stubs);
  writeFileSync(
    join(stubs, 'codex'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "codex-cli 0.160.1" ;;',
      '  login) exit 0 ;;',
      '  *) echo "install check: no backend" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(join(stubs, 'codex'), 0o755);

  const base = { ...process.env };
  // A database or MAMA home from the caller's shell would point the CLI at another install.
  for (const name of [
    'MAMA_HOME',
    'MAMA_SOCKET_PATH',
    'MAMA_DB_PATH',
    'MAMA_DATABASE_PATH',
    'MAMA_FORCE_TIER_3',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'CODEX_INSTALL_DIR',
  ]) {
    delete base[name];
  }
  const shellPath = vendorInstallers ? base.PATH : `${stubs}:${base.PATH}`;
  if (vendorInstallers) {
    for (const backend of ['codex', 'claude']) {
      const found = spawnSync('sh', ['-c', `command -v ${backend}`], {
        env: base,
        encoding: 'utf8',
      }).stdout.trim();
      expect(found === '', `${backend} is already on PATH (${found}); its installer would not run`);
    }
  }
  const scriptEnv = (home, extra = {}) => ({
    ...base,
    HOME: home,
    SHELL: '/bin/sh',
    PATH: shellPath,
    npm_config_registry: registry,
    npm_config_node_gyp: '/bin/false',
    npm_config_cache: join(homedir(), '.npm'),
    npm_config_update_notifier: 'false',
    ...extra,
  });
  const home = join(root, 'home');
  mkdirSync(home);
  const mama = join(home, '.mama');
  const managedNode = join(mama, 'node', 'bin', 'node');
  const prefix = join(mama, 'npm');
  const packageRoot = join(prefix, 'lib', 'node_modules', '@jungjaehoon', 'mama-os');
  const wrapper = join(mama, 'bin', 'mama');

  // 1. The install.
  const first = await runScript(
    'install.sh',
    text,
    ['--backend', 'codex', '--no-init'],
    scriptEnv(home)
  );
  expect(first.status === 0, `install.sh exited ${first.status}`);
  expect(
    capture(managedNode, ['--version'], base).stdout.trim() === `v${pin.version}`,
    `the managed Node is not ${pin.version}`
  );
  expect(
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version === N,
    `${packageRoot} is not ${N}`
  );
  expect(
    readFileSync(wrapper, 'utf8') ===
      `#!/bin/sh\nexec '${managedNode}' '${join(packageRoot, 'dist', 'cli', 'index.js')}' "$@"\n`,
    `the wrapper is not the two lines: ${readFileSync(wrapper, 'utf8')}`
  );
  expect(
    readFileSync(join(home, '.profile'), 'utf8').includes('export PATH="$HOME/.mama/bin:'),
    'the startup block is not in ~/.profile'
  );
  if (process.platform === 'linux') {
    const user = userInfo().username;
    const parent = statSync('/var/lib/mama');
    const own = statSync(`/var/lib/mama/${user}`);
    expect(
      (parent.mode & 0o777) === 0o755 && parent.uid === 0,
      `/var/lib/mama is ${(parent.mode & 0o777).toString(8)} owned by ${parent.uid}`
    );
    expect(
      (own.mode & 0o777) === 0o700 && own.uid === process.getuid(),
      `/var/lib/mama/${user} is ${(own.mode & 0o777).toString(8)} owned by ${own.uid}`
    );
    expect(existsSync(`/var/lib/systemd/linger/${user}`), 'linger is not on');
  }
  if (vendorInstallers) {
    const codex = join(home, '.local', 'bin', 'codex');
    const probe = probeBackend('codex', codex, { codexHome: join(mama, '.codex') });
    expect(probe.versionOk, `codex ${probe.version} is below ${probe.minimum}`);
    console.log(`install check: the Codex installer gave codex ${probe.version}`);
    expect(
      readFileSync(join(home, '.profile'), 'utf8').includes(
        'export PATH="$HOME/.mama/bin:$HOME/.local/bin:$PATH"'
      ),
      'the startup block does not name ~/.local/bin, where codex went'
    );
  }

  // 2. Init under the managed Node, then the service files through the wrapper.
  const members = join(root, 'members');
  const tools = join(root, 'tools');
  mkdirSync(members, { mode: 0o700 });
  mkdirSync(tools, { mode: 0o700 });
  const managedEnv = {
    ...base,
    HOME: home,
    PATH: `${stubs}:${join(mama, 'node', 'bin')}:${base.PATH}`,
    MAMA_API_PORT: String(await freePort()),
    MAMA_INIT_BACKEND: 'codex',
    MAMA_INIT_MODEL: 'fixture-model',
    MAMA_INIT_TIMEZONE: 'UTC',
    // Linux keeps the defaults: the folder the sudo call made.
    ...(process.platform === 'linux'
      ? {}
      : { MAMA_INIT_MEMBER_ROOT: members, MAMA_INIT_TOOLS_ROOT: tools }),
  };
  const init = capture(managedNode, [join(here, 'managed.mjs'), 'init', packageRoot], managedEnv);
  expect(init.status === 0, `init exited ${init.status}`);
  expect(existsSync(join(mama, 'config.yaml')), 'init wrote no config.yaml');

  const fakes = join(root, 'fakes');
  mkdirSync(fakes);
  for (const tool of ['launchctl', 'systemctl']) {
    writeFileSync(
      join(fakes, tool),
      `#!/bin/sh\nexec '${process.execPath}' '${join(standalone, 'scripts', 'upgrade-check', 'fake-service.cjs')}' ${tool} "$@"\n`
    );
    chmodSync(join(fakes, tool), 0o755);
  }
  // This runner's own Node (setup-node in CI) first after the stand-ins: start.sh must still
  // name the managed one.
  const serviceEnv = {
    ...base,
    HOME: home,
    PATH: `${fakes}:${dirname(process.execPath)}:${stubs}:${base.PATH}`,
    npm_config_registry: registry,
    npm_config_cache: join(homedir(), '.npm'),
    npm_config_update_notifier: 'false',
  };
  // On a developer's Mac the real launchctl would act on the owner's own daemon.
  expect(
    spawnSync('launchctl', ['fake-check'], { env: serviceEnv, encoding: 'utf8' }).stdout?.trim() ===
      'fake',
    'the stand-in service manager is not first on PATH'
  );
  expect(capture(wrapper, ['service', 'install'], serviceEnv).status === 0, 'service install');
  const exec = readFileSync(join(mama, 'start.sh'), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('exec '));
  expect(
    exec?.startsWith(`exec '${managedNode}' '${join(packageRoot, 'dist', 'cli', 'index.js')}' `),
    `start.sh runs ${exec}`
  );
  const kind = JSON.parse(
    capture(managedNode, [join(here, 'managed.mjs'), 'kind', packageRoot], { ...base, HOME: home })
      .stdout
  );
  expect(
    kind.kind === 'npm' && kind.prefix === prefix && kind.nodePath === managedNode,
    `installKind is ${JSON.stringify(kind)}`
  );
  const doctor = capture(wrapper, ['doctor', '--json', '--offline'], serviceEnv);
  let checks;
  try {
    checks = JSON.parse(doctor.stdout).checks;
  } catch {
    throw new Error(`install check: doctor printed no report (exit ${doctor.status})`);
  }
  const nodeCheck = checks.find((check) => check.name === 'node');
  expect(nodeCheck?.status === 'ok', `doctor's Node check: ${JSON.stringify(nodeCheck)}`);
  const dry = capture(wrapper, ['update', N1, '--dry-run'], serviceEnv);
  expect(
    dry.status === 0 &&
      dry.output.includes(`${NAME} ${N} → ${N1}`) &&
      dry.output.includes(`prefix ${prefix}`),
    'mama update --dry-run does not show N → N+1 on the managed prefix'
  );
  console.log(
    `install check: start.sh runs ${managedNode}; installKind npm at ${prefix}; doctor node ${nodeCheck.detail}`
  );

  // 3. A second run changes nothing.
  const watched = process.platform === 'linux' ? [home, '/var/lib/mama'] : [home];
  const before = Object.assign({}, ...watched.map(snapshot));
  const second = await runScript(
    'second run',
    text,
    ['--backend', 'codex', '--no-init'],
    scriptEnv(home)
  );
  expect(second.status === 0, `the second run exited ${second.status}`);
  // The script runs the backend it finds (`--version`, finding A), and Codex makes new arg0 links
  // under its own home's tmp/ each time it starts. That is the backend's scratch, not a file the
  // install command writes.
  const codexScratch = join(home, '.codex', 'tmp');
  const changed = sameSnapshot(before, Object.assign({}, ...watched.map(snapshot))).filter(
    (path) => path !== codexScratch && !path.startsWith(`${codexScratch}/`)
  );
  expect(changed.length === 0, `the second run changed ${changed.join(', ')}`);

  // A run on a finished install ends at init's status and exits 0. Init's service step is
  // recorded as done here, since this check boots no daemon to finish it.
  capture(managedNode, [join(here, 'managed.mjs'), 'finish', packageRoot], { ...base, HOME: home });
  const finished = await runScript(
    'finished',
    text,
    ['--backend', 'codex', '--non-interactive'],
    scriptEnv(home)
  );
  expect(
    finished.status === 0 && finished.output.includes('MAMA is already set up here'),
    `a run on a finished install exited ${finished.status}`
  );

  // A run cut off after Node (npm cannot reach its registry) skips Node the next time.
  const cutHome = join(root, 'cut-home');
  mkdirSync(cutHome);
  const cutNode = join(cutHome, '.mama', 'node', 'bin', 'node');
  const cut = await runScript(
    'cut off',
    text,
    ['--backend', 'codex', '--no-init'],
    scriptEnv(cutHome, {
      npm_config_registry: `http://127.0.0.1:${await freePort()}`,
      npm_config_fetch_retries: '0',
    })
  );
  expect(cut.status === 1, `the cut-off run exited ${cut.status}`);
  expect(existsSync(cutNode), 'the cut-off run left no Node');
  const nodeBefore = statSync(cutNode);
  const resumed = await runScript(
    'resumed',
    text,
    ['--backend', 'codex', '--no-init'],
    scriptEnv(cutHome)
  );
  expect(resumed.status === 0, `the resumed run exited ${resumed.status}`);
  const nodeAfter = statSync(cutNode);
  expect(
    resumed.output.includes(`Node.js ${pin.version} is in place`) &&
      nodeAfter.ino === nodeBefore.ino &&
      nodeAfter.mtimeMs === nodeBefore.mtimeMs,
    'the resumed run did not skip Node'
  );
  expect(existsSync(join(cutHome, '.mama', 'bin', 'mama')), 'the resumed run wrote no wrapper');

  // A truncated script runs nothing: cut inside the function, and cut before its call.
  const lines = text.split('\n');
  for (const [label, partial] of [
    ['half', text.slice(0, Math.floor(text.length / 2))],
    ['no call', lines.slice(0, lines.lastIndexOf('mama_install "$@"')).join('\n')],
  ]) {
    const emptyHome = join(root, `truncated-${label.replace(' ', '-')}`);
    mkdirSync(emptyHome);
    await runScript(
      `truncated (${label})`,
      partial,
      ['--backend', 'codex', '--no-init'],
      scriptEnv(emptyHome)
    );
    expect(readdirSync(emptyHome).length === 0, `the truncated script (${label}) wrote files`);
  }

  // 4. The vendors' installers, as the script runs them.
  if (vendorInstallers) {
    const claudeRun = await runScript(
      'claude',
      text,
      ['--backend', 'claude', '--no-init'],
      scriptEnv(home)
    );
    expect(claudeRun.status === 0, `install.sh --backend claude exited ${claudeRun.status}`);
    const claude = join(home, '.local', 'bin', 'claude');
    const probe = probeBackend('claude', claude);
    expect(probe.versionOk, `claude ${probe.version} is below ${probe.minimum}`);
    console.log(`install check: the Claude Code installer gave claude ${probe.version}`);
  } else {
    console.log('install check: vendor installers not run (no --vendor-installers); CI runs them');
  }

  // 5. The Node move.
  await moveLeg({
    root,
    home,
    text,
    pin,
    scriptEnv,
    runScript,
    serviceEnv,
    track: (child) => children.push(child),
  });

  // 6. A source's tool. No Node on this PATH: gws is a Node script, so the commands must bring
  // the managed one. The stand-in service manager stays first, as in step 2.
  const bare = '/usr/bin:/bin:/usr/sbin:/sbin';
  const toolEnv = {
    HOME: home,
    PATH: bare,
    npm_config_cache: join(homedir(), '.npm'),
    npm_config_update_notifier: 'false',
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
  for (const command of ['node', 'gws']) {
    const found = capture('sh', ['-c', `command -v ${command} || true`], toolEnv).stdout.trim();
    expect(found === '', `${command} is on ${bare} (${found})`);
  }
  writeFileSync(
    join(mama, 'connectors.json'),
    `${JSON.stringify({
      gmail: {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: { inbox: { role: 'hub' } },
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      },
    })}\n`
  );
  const gmailCheck = () => {
    const report = capture(wrapper, ['doctor', '--json', '--offline'], {
      ...toolEnv,
      PATH: `${fakes}:${bare}`,
    });
    return JSON.parse(report.stdout).checks.find((check) => check.name === 'source gmail');
  };
  const missing = gmailCheck();
  const printed = /^install it: (.*); then log in: (.*)$/.exec(missing?.fix ?? '');
  const install =
    'PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/node/bin/npm install -g --prefix ~/.mama/npm @googleworkspace/cli';
  const login = 'PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/npm/bin/gws auth login';
  expect(
    printed?.[1] === install && printed?.[2] === login,
    `doctor's fix for Gmail without gws: ${JSON.stringify(missing)}`
  );
  expect(capture('sh', ['-c', install], toolEnv).status === 0, `${install} failed`);
  // The postinstall put the binary in place (npm may warn about install scripts and still run
  // them); without it, run.js would fetch it on gws's first run instead. install.js writes
  // bin/.version last, after the binary.
  const gwsPackage = join(prefix, 'lib', 'node_modules', '@googleworkspace', 'cli');
  const gwsVersion = join(gwsPackage, 'bin', '.version');
  expect(
    existsSync(gwsVersion) &&
      readFileSync(gwsVersion, 'utf8').trim() ===
        JSON.parse(readFileSync(join(gwsPackage, 'package.json'), 'utf8')).version,
    `the @googleworkspace/cli postinstall did not finish: no matching ${gwsVersion}`
  );
  for (const args of ['--version', 'auth --help']) {
    const run = capture('sh', ['-c', login.replace(/ auth login$/, ` ${args}`)], toolEnv);
    expect(run.status === 0, `gws ${args}, as the printed login runs it, exited ${run.status}`);
  }
  expect(gmailCheck() === undefined, `doctor after the install: ${JSON.stringify(gmailCheck())}`);
  console.log('install check: gws installed and run as doctor printed, with only the managed Node');
  console.log('install check: passed');
} finally {
  for (const child of children) {
    child.kill();
  }
  // A daemon a failed step left running.
  spawnSync(
    process.execPath,
    [
      join(standalone, 'scripts', 'upgrade-check', 'fake-service.cjs'),
      'systemctl',
      '--user',
      'stop',
      'mama.service',
    ],
    { env: { ...process.env, HOME: join(root, 'home') } }
  );
  rmSync(root, { recursive: true, force: true });
}
