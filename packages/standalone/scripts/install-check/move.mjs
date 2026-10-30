/**
 * The Node move's leg (docs/development/work/install.md, "Moving the managed Node", PR 2), on the
 * install run.mjs made, with its daemon booted through the stand-in service manager and the Bot
 * API stand-in (scripts/upgrade-check). install.sh is run again with other Node pins, as an owner
 * runs the published command after a release moves its pin:
 *
 * 1. A patch pin: Node N → N+1 moves through `mama update --node`, and the daemon runs on it.
 * 2. The move back, killed (SIGKILL) right after each journal write and each rename (kill.cjs):
 *    the journal and, from the stop on, the hold stay, and start.sh exits at once on the hold;
 *    the next run of the script undoes the move (or, killed once committed, finishes it), and the
 *    daemon runs on the Node it says.
 * 3. A pin whose Node cannot boot MAMA (it loads SQLite, so doctor's check passes, and exits at
 *    `daemon`): the move puts the old Node back and starts it; the script exits 1.
 * 4. A major pin (22 → 24): killed with the new Node beside the old prefix and undone; then the
 *    npm prefix is copied and rebuilt with the new Node's npm (no node-gyp: the prebuilt binaries
 *    must cover that ABI), and the daemon runs on it.
 *
 * Node.js tarballs come from nodejs.org once each, checked against its SHASUMS256.txt; the script
 * then gets them from a curl that serves that cache (the real download is run.mjs's first step).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, until } from '../local-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const upgrade = join(here, '..', 'upgrade-check');

function expect(ok, message) {
  if (!ok) {
    throw new Error(`move leg: ${message}`);
  }
}

const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const shaName = `NODE_SHA256_${os.toUpperCase()}_${arch.toUpperCase()}`;
const tarballName = (version) => `node-v${version}-${os}-${arch}.tar.gz`;

/**
 * @param {object} leg
 * @param {string} leg.root run.mjs's temp root
 * @param {string} leg.home the HOME run.mjs installed into
 * @param {string} leg.text install.sh
 * @param {{ version: string }} leg.pin install/node.json
 * @param {(home: string, extra?: object) => NodeJS.ProcessEnv} leg.scriptEnv
 * @param {(label: string, text: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ status: number | null, output: string }>} leg.runScript
 * @param {NodeJS.ProcessEnv} leg.serviceEnv run.mjs's environment for `mama service install`:
 *   the stand-in service manager and the backend first on PATH
 * @param {(child: import('node:child_process').ChildProcess) => void} leg.track
 */
export async function moveLeg({ root, home, text, pin, scriptEnv, runScript, serviceEnv, track }) {
  const mama = join(home, '.mama');
  const wrapper = join(mama, 'bin', 'mama');
  const work = join(root, 'move');
  const cache = join(work, 'cache');
  mkdirSync(cache, { recursive: true });

  // The Node releases: the pin, the 22.x before it, and the newest 24.x.
  const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
  const versions = index.map((release) => release.version.slice(1));
  const older = (a, b) => {
    const [x, y] = [a, b].map((version) => version.split('.').map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  const N = pin.version;
  const N1 = versions
    .filter((version) => version.startsWith('22.') && older(version, N) < 0)
    .sort(older)
    .at(-1);
  const M = versions
    .filter((version) => version.startsWith('24.'))
    .sort(older)
    .at(-1);
  expect(N1 && M, `nodejs.org lists no 22.x before ${N} or no 24.x`);

  /** An official tarball into the cache, checked against nodejs.org's SHASUMS256.txt. */
  const official = async (version) => {
    const sums = await (await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)).text();
    const hash = sums
      .split('\n')
      .find((line) => line.endsWith(`  ${tarballName(version)}`))
      ?.split(' ')[0];
    expect(hash, `SHASUMS256.txt for ${version} names no ${tarballName(version)}`);
    const body = Buffer.from(
      await (
        await fetch(`https://nodejs.org/dist/v${version}/${tarballName(version)}`)
      ).arrayBuffer()
    );
    expect(createHash('sha256').update(body).digest('hex') === hash, `${version}'s hash`);
    writeFileSync(join(cache, tarballName(version)), body);
    return { version, hash };
  };
  const nodes = { [N]: await official(N), [N1]: await official(N1), [M]: await official(M) };

  // A Node that loads SQLite (doctor's check passes) and exits at once as the daemon.
  const F = '22.99.0';
  {
    const tree = join(work, 'fabricated');
    const folder = join(tree, `node-v${F}-${os}-${arch}`);
    mkdirSync(tree);
    spawnSync('tar', ['-xzf', join(cache, tarballName(N)), '-C', tree], { stdio: 'inherit' });
    renameSync(join(tree, `node-v${N}-${os}-${arch}`), folder);
    renameSync(join(folder, 'bin', 'node'), join(folder, 'bin', 'node-real'));
    writeFileSync(
      join(folder, 'bin', 'node'),
      [
        '#!/bin/sh',
        `[ "$1" = --version ] && { echo v${F}; exit 0; }`,
        'case " $* " in *" daemon "*) echo "move leg: this Node does not boot MAMA" >&2; exit 1 ;; esac',
        'exec "$(dirname "$0")/node-real" "$@"',
        '',
      ].join('\n')
    );
    chmodSync(join(folder, 'bin', 'node'), 0o755);
    const file = join(cache, tarballName(F));
    spawnSync('tar', ['-czf', file, '-C', tree, `node-v${F}-${os}-${arch}`], { stdio: 'inherit' });
    nodes[F] = { version: F, hash: createHash('sha256').update(readFileSync(file)).digest('hex') };
  }
  console.log(`move leg: Node ${N} (pin), ${N1}, ${M}, and ${F} (exits at boot)`);

  // The curl install.sh finds first: nodejs.org from the cache, anything else from the real one.
  const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();
  const shim = join(work, 'bin');
  mkdirSync(shim);
  writeFileSync(
    join(shim, 'curl'),
    [
      '#!/bin/sh',
      'out=""; url=""',
      'for arg; do [ "$prev" = -o ] && out=$arg; prev=$arg; url=$arg; done',
      `cached='${cache}'/$(basename "$url")`,
      'case $url in https://nodejs.org/dist/*) [ -f "$cached" ] && exec cp "$cached" "$out" ;; esac',
      `exec '${realCurl}' "$@"`,
      '',
    ].join('\n')
  );
  chmodSync(join(shim, 'curl'), 0o755);
  /** install.sh as a release pinning `version` would ship it. */
  const pinned = (version) =>
    text
      .replace(/^ {2}NODE_VERSION=.*$/m, `  NODE_VERSION=${version}`)
      .replace(new RegExp(`^ {2}${shaName}=.*$`, 'm'), `  ${shaName}=${nodes[version].hash}`);

  // The daemon's boot: the Bot API stand-in, and the viewer on a port of its own.
  const portFile = join(work, 'telegram.port');
  track(
    spawn(process.execPath, [join(upgrade, 'fake-telegram.cjs'), 'serve', portFile], {
      stdio: 'inherit',
    })
  );
  const telegramPort = await until(
    'the Bot API stand-in listens',
    () => existsSync(portFile) && readFileSync(portFile, 'utf8'),
    30_000
  );
  const env = (extra = {}) => {
    const shell = scriptEnv(home);
    return {
      ...shell,
      PATH: `${shim}:${serviceEnv.PATH}`,
      // A boot that never comes fails in two minutes, not the owner's ten.
      MAMA_UPDATE_WAIT_MS: '120000',
      ...extra,
    };
  };
  // On a developer's Mac the real launchctl would act on the owner's own daemon.
  expect(
    spawnSync('launchctl', ['fake-check'], { env: env(), encoding: 'utf8' }).stdout?.trim() ===
      'fake',
    'the stand-in service manager is not first on PATH'
  );
  const mamaCli = (args) => {
    const result = spawnSync(wrapper, args, { env: env(), encoding: 'utf8', timeout: 600_000 });
    if (result.error) {
      throw result.error;
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    console.log(output.trimEnd().replace(/^/gm, `  mama ${args.join(' ')} | `));
    return { status: result.status, output };
  };
  // What `mama service install` carries over into start.sh: the port and the Bot API stand-in.
  const startPath = join(mama, 'start.sh');
  const exports = [
    `export MAMA_API_PORT='${await freePort()}'`,
    `export NODE_OPTIONS='--require ${join(upgrade, 'fake-telegram.cjs')}'`,
    `export MAMA_FAKE_TELEGRAM_PORT='${telegramPort}'`,
  ];
  writeFileSync(
    startPath,
    readFileSync(startPath, 'utf8').replace(/^exec /m, `${exports.join('\n')}\nexec `)
  );
  expect(mamaCli(['service', 'install']).status === 0, 'mama service install');
  expect(
    exports.every((line) => readFileSync(startPath, 'utf8').includes(line)),
    'start.sh did not carry the exports'
  );

  const status = () => {
    const result = spawnSync(wrapper, ['status', '--json'], { env: env(), encoding: 'utf8' });
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  };
  const runsOn = (version) =>
    until(
      `the daemon runs on Node.js ${version}`,
      () => {
        const now = status();
        return now?.state === 'running' &&
          now.status.stage === 'running' &&
          now.status.node === `v${version}`
          ? now
          : null;
      },
      300_000
    );
  const managedNode = () =>
    spawnSync(join(mama, 'node', 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim();
  const journal = join(mama, 'runtime', 'node-move.json');
  const hold = join(mama, 'runtime', 'update.hold');
  const settled = (version) => {
    expect(managedNode() === `v${version}`, `the managed Node is ${managedNode()}, not ${version}`);
    const left = readdirSync(mama).filter((name) => /^(node|npm)\.(new|old)$/.test(name));
    expect(left.length === 0, `the move left ${left.join(', ')}`);
    expect(!existsSync(journal), 'the journal is still there');
    expect(!existsSync(hold), 'the hold is still there');
  };
  const install = (label, version, extra = {}) =>
    runScript(label, pinned(version), ['--backend', 'codex', '--no-init'], env(extra));

  expect(mamaCli(['service', 'start']).status === 0, 'mama service start');
  await runsOn(N);

  // 1. A patch pin.
  const patch = await install(`pin ${N1}`, N1);
  expect(
    patch.status === 0 && patch.output.includes(`moved: MAMA runs on Node.js ${N1} (was ${N})`),
    `the move to ${N1} exited ${patch.status}`
  );
  settled(N1);
  await runsOn(N1);

  // 2. The move back to N, killed after each journal write and each rename.
  const killer = join(here, 'kill.cjs');
  for (const [at, held, finished] of [
    ['node-move.json#1', false, false], // step 1 begun
    ['node-move.json#2', false, false], // step 3 begun, before the stop
    ['node.old#1', true, false], // the old Node set aside
    ['node#1', true, false], // the new Node in place
    ['node-move.json#3', true, false], // step 4 begun
    ['node-move.json#4', false, true], // committed
  ]) {
    const killed = await install(`killed at ${at}`, N, {
      NODE_OPTIONS: `--require ${killer}`,
      MAMA_KILL_AT: at,
    });
    expect(
      killed.status === 1 && killed.output.includes('did not finish'),
      `the run killed at ${at} exited ${killed.status}`
    );
    expect(existsSync(journal), `killed at ${at}: no journal`);
    expect(
      existsSync(hold) === held,
      `killed at ${at}: the hold is ${existsSync(hold) ? 'there' : 'not there'}`
    );
    if (held) {
      // A start meanwhile (a reboot) runs nothing.
      const started = spawnSync('sh', [startPath], {
        env: env(),
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(started.status === 0, `start.sh exited ${started.status} on the hold`);
      // Asked of the stand-in service manager: ~/.mama/node may be missing now, and the wrapper
      // with it.
      const active = spawnSync(
        process.execPath,
        [join(upgrade, 'fake-service.cjs'), 'systemctl', '--user', 'is-active', 'mama.service'],
        { env: env(), encoding: 'utf8' }
      ).stdout.trim();
      expect(active === 'inactive', `killed at ${at}: a daemon runs on the hold (${active})`);
    }
    const recovered = await install(`recovered from ${at}`, N);
    if (finished) {
      expect(
        recovered.status === 0 && recovered.output.includes(`move to ${N} had taken effect`),
        `the run after ${at} exited ${recovered.status}`
      );
      settled(N);
      await runsOn(N);
    } else {
      expect(
        recovered.status === 1 &&
          recovered.output.includes(
            `the move of the managed Node from ${N1} to ${N} was cut off, and is undone`
          ),
        `the run after ${at} exited ${recovered.status}`
      );
      settled(N1);
      await runsOn(N1);
    }
  }
  console.log(`move leg: killed at each step and recovered; Node ${managedNode()}`);

  // 3. A Node that does not boot MAMA.
  const failed = await install(`pin ${F}`, F);
  expect(
    failed.status === 1 &&
      failed.output.includes(`not moved: Node.js ${N} runs MAMA again; Node.js ${F} is removed`),
    `the move to ${F} exited ${failed.status}`
  );
  settled(N);
  await runsOn(N);

  // 4. A major pin: first killed with the new Node in place beside the old prefix, whose native
  // modules it cannot load (the recovery runs no command on that Node), then moved.
  const between = await install(`pin ${M}, killed at node#1`, M, {
    NODE_OPTIONS: `--require ${killer}`,
    MAMA_KILL_AT: 'node#1',
  });
  expect(
    between.status === 1 && existsSync(hold),
    `the major move killed at node#1 exited ${between.status}`
  );
  const undone = await install(`recovered from ${M}'s node#1`, M);
  expect(
    undone.status === 1 &&
      undone.output.includes(
        `the move of the managed Node from ${N} to ${M} was cut off, and is undone`
      ),
    `the run after ${M}'s node#1 exited ${undone.status}`
  );
  settled(N);
  await runsOn(N);
  const major = await install(`pin ${M}`, M);
  expect(
    major.status === 0 && major.output.includes(`moved: MAMA runs on Node.js ${M} (was ${N})`),
    `the move to ${M} exited ${major.status}`
  );
  settled(M);
  await runsOn(M);
  console.log(`move leg: ${N} → ${N1}, recovered kills, ${F} put back, ${N} → ${M} rebuilt`);

  expect(mamaCli(['stop']).status === 0, 'mama stop');
}
