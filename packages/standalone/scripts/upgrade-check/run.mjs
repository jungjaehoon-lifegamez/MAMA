#!/usr/bin/env node
/**
 * Upgrade check (v1.md R5): the previous published MAMA OS sets up an install and writes to it
 * the way its owner would, then this checkout boots on that install and reads it back.
 *
 * 1. Previous = the highest published @jungjaehoon/mama-os at or below this checkout's version,
 *    installed with the mama-core it was released with: the floor of its dependency range. The
 *    range itself would pull a later core, and the "previous" install would be written by new code.
 * 2. That release's own setup, as the owner's agent runs it: install-check/managed.mjs drives its
 *    `mama init --non-interactive` and enters the bot token and the pairing code on its setup page
 *    (the owner it registers and the common group come from the stand-in Bot API there), then its
 *    `mama init --section connectors --non-interactive` adds an Obsidian source.
 * 3. writer.mjs runs on that install: work, a revision, a lesson and a pending owner message
 *    through its own actions.
 * 4. reader.mjs boots this checkout's build on the same home and compares what it reads with what
 *    the writer recorded; `mama doctor --offline` then holds the config and the migrated schema.
 * 5. update.mjs: on that home, `mama update` from a local registry goes N → N+1 and rolls back
 *    from an N+2 that exits at boot (docs/development/work/update.md, PR 3).
 *
 * managed.mjs is the one setup driver: install-check runs it on this checkout, this check on the
 * previous release. A change to the setup fails install-check on the pull request that makes it,
 * and this check says so when the driver no longer sets up the release before it; until that
 * change is published, the driver has to set up both.
 *
 * Needs network (npm) and the embedding model; CI runs it as its own job, outside `pnpm test`.
 * Run after `pnpm build`: node packages/standalone/scripts/upgrade-check/run.mjs
 * On a developer machine it uses the real npm cache and links the real model cache
 * (~/.cache/huggingface/transformers; a cold cache downloads the model there, about 400 MB).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateLeg } from './update.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const standalone = join(here, '..', '..');
const current = JSON.parse(readFileSync(join(standalone, 'package.json'), 'utf8')).version;

// Each step is bounded, so a hung boot fails the check instead of the CI job's own limit.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

const compare = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const published = JSON.parse(run('npm', ['view', '@jungjaehoon/mama-os', 'versions', '--json']));
// Right after a release this is the release itself, the version main still carries: main then
// gathers the next release's changes on top of it, and that is the upgrade its owners make. One
// that cannot be set up fails the check; an older release is never tried instead.
const previous = published
  .filter((version) => /^\d+\.\d+\.\d+$/.test(version) && compare(version, current) <= 0)
  .sort(compare)
  .at(-1);
if (!previous) {
  throw new Error(`no published mama-os at or below ${current}`);
}
const coreRange = JSON.parse(
  run('npm', ['view', `@jungjaehoon/mama-os@${previous}`, 'dependencies', '--json'])
)['@jungjaehoon/mama-core'];
const core = /^\^?(\d+\.\d+\.\d+)$/.exec(coreRange ?? '')?.[1];
if (!core) {
  throw new Error(`mama-os ${previous} names mama-core ${coreRange}, not a version range`);
}
console.log(
  `upgrade check: mama-os ${previous} on mama-core ${core}, then this checkout (${current})`
);

// Not os.tmpdir(): a sandboxed shell's TMPDIR can sit under a path MAMA denies to member sessions,
// where the old release refuses tools_root and member_root, and the install's control socket path
// must stay under the 104-byte limit of a Unix socket.
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? '/tmp', 'mama-upgrade-'));
// An interrupt during a step reaches the child as well, the step fails and `finally` cleans up;
// these cover one that lands between steps, which would otherwise skip it.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    rmSync(root, { recursive: true, force: true });
    process.exit(code);
  });
}
try {
  const install = join(root, 'previous');
  mkdirSync(install);
  writeFileSync(
    join(install, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { '@jungjaehoon/mama-os': previous, '@jungjaehoon/mama-core': core },
      overrides: { '@jungjaehoon/mama-core': core },
    })
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: install,
    stdio: 'inherit',
  });
  // The core mama-os loads is the one resolved from its own folder, not necessarily the top one.
  const os = join(install, 'node_modules', '@jungjaehoon', 'mama-os', 'package.json');
  for (const [name, path, version] of [
    ['mama-os', os, previous],
    [
      'mama-core',
      // Node's own search order from mama-os; core does not export its package.json.
      createRequire(os)
        .resolve.paths('@jungjaehoon/mama-core')
        .map((dir) => join(dir, '@jungjaehoon', 'mama-core', 'package.json'))
        .find((path) => existsSync(path)),
      core,
    ],
  ]) {
    const installed = JSON.parse(readFileSync(path, 'utf8')).version;
    if (installed !== version) {
      throw new Error(`npm installed ${name} ${installed}, not ${version}`);
    }
  }
  copyFileSync(join(here, 'writer.mjs'), join(install, 'writer.mjs'));

  const home = join(root, 'home');
  mkdirSync(join(home, 'vault'), { recursive: true });
  // Named to init, which takes only folders no other account can write.
  const tools = join(root, 'tools');
  const members = join(root, 'members');
  mkdirSync(tools, { mode: 0o700 });
  mkdirSync(members, { mode: 0o700 });
  // Work and lessons are embedded when written; share the model cache instead of downloading it.
  const models = join(homedir(), '.cache', 'huggingface', 'transformers');
  mkdirSync(models, { recursive: true });
  mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true });
  symlinkSync(models, join(home, '.cache', 'huggingface', 'transformers'));

  const freePort = () =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  // MAMA needs its backend on PATH to boot. The check runs no model: this stand-in answers init's
  // version and login probe as install-check's does, and exits at once for anything else, so the
  // turn started for the pending message ends there, and a real backend is never started.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'codex'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "codex-cli 0.160.1" ;;',
      '  login) exit 0 ;;',
      '  *) echo "upgrade check: no backend" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(join(bin, 'codex'), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  // Each release writes its own database path into the config, and work cannot be written with
  // embeddings switched off.
  delete env.MAMA_DB_PATH;
  delete env.MAMA_DATABASE_PATH;
  delete env.MAMA_FORCE_TIER_3;
  const written = join(root, 'written.json');

  // The previous release's setup. Its output is above a failure; the message names the step.
  const setup = (refused, args, extra) => {
    try {
      run(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } });
    } catch (error) {
      throw new Error(`upgrade check: mama-os ${previous} did not take ${refused}`, {
        cause: error,
      });
    }
  };
  const previousRoot = dirname(os);
  setup(
    'the setup install-check/managed.mjs drives: mama init --non-interactive with MAMA_INIT_* ' +
      'answers, then the bot token and the pairing code on the setup page. If it sets up ' +
      'another way, managed.mjs must drive that too: it sets up this checkout in install-check ' +
      'and the newest published release here.',
    [join(here, '..', 'install-check', 'managed.mjs'), 'init', previousRoot],
    {
      MAMA_API_PORT: String(await freePort()),
      MAMA_INIT_BACKEND: 'codex',
      MAMA_INIT_MODEL: 'fixture-model',
      MAMA_INIT_TIMEZONE: 'UTC',
      MAMA_INIT_MEMBER_ROOT: members,
      MAMA_INIT_TOOLS_ROOT: tools,
    }
  );
  // Through the release's own command, as the owner's agent adds a source after the setup.
  const cli = join(previousRoot, JSON.parse(readFileSync(os, 'utf8')).bin.mama);
  setup(
    'mama init --section connectors --non-interactive with an Obsidian block in ' +
      'MAMA_INIT_CONNECTORS, as its owner adds a source.',
    [cli, 'init', '--section', 'connectors', '--non-interactive'],
    {
      MAMA_INIT_CONNECTORS: JSON.stringify({
        obsidian: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { vault: { role: 'hub', name: 'Vault', vaultPath: join(home, 'vault') } },
          auth: { type: 'none' },
        },
      }),
    }
  );

  run(process.execPath, [join(install, 'writer.mjs'), written], {
    cwd: install,
    stdio: 'inherit',
    env: { ...env, MAMA_API_PORT: String(await freePort()) },
  });
  run(process.execPath, [join(here, 'reader.mjs'), written], {
    stdio: 'inherit',
    env: { ...env, MAMA_API_PORT: String(await freePort()) },
  });

  // Doctor exits non-zero for checks a CI host fails (no signed-in backend, no sandbox); only the
  // config and schema rows are this check's.
  const doctor = spawnSync(
    process.execPath,
    [join(standalone, 'dist', 'cli', 'index.js'), 'doctor', '--json', '--offline'],
    { encoding: 'utf8', env, timeout: 120_000 }
  );
  if (doctor.error) {
    throw doctor.error;
  }
  let checks;
  try {
    checks = JSON.parse(doctor.stdout).checks;
  } catch {
    throw new Error(`doctor printed no report (exit ${doctor.status}):\n${doctor.stderr}`);
  }
  for (const name of ['config', 'schema']) {
    const check = checks.find((entry) => entry.name === name);
    if (check?.status !== 'ok') {
      throw new Error(`doctor ${name}: ${JSON.stringify(check)}`);
    }
  }
  // Every source at the highest version this build ships: "core 106 of 106, standalone 1 of 1".
  const schema = checks.find((entry) => entry.name === 'schema').detail;
  const sources = [...schema.matchAll(/(\S+) (\d+) of (\d+)/g)];
  if (sources.length === 0 || sources.some(([, , stored, highest]) => stored !== highest)) {
    throw new Error(`doctor schema is not this build's: ${schema}`);
  }
  console.log(`upgrade check: doctor config ok, schema ${schema}`);

  // The same install, updated by `mama update` from a local registry and rolled back.
  await updateLeg({ root, home, env });
} finally {
  rmSync(root, { recursive: true, force: true });
}
