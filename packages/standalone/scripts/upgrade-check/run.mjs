#!/usr/bin/env node
/**
 * Upgrade check (v1.md R5): the previous published MAMA OS sets up an install and writes to it
 * the way its owner would, then this checkout boots on that install and reads it back.
 *
 * 1. Previous = the highest published @jungjaehoon/mama-os at or below this checkout's version,
 *    installed with the mama-core it was released with: the floor of its dependency range. The
 *    range itself would pull a later core, and the "previous" install would be written by new code.
 * 2. writer.mjs runs on that install: its own `mama init` and `mama register-owner`, then work, a
 *    revision, a lesson and a pending owner message through its own actions.
 * 3. reader.mjs boots this checkout's build on the same home and compares what it reads with what
 *    the writer recorded; `mama doctor --offline` then holds the config and the migrated schema.
 *
 * Needs network (npm) and the embedding model; CI runs it as its own job, outside `pnpm test`.
 * Run after `pnpm build`: node packages/standalone/scripts/upgrade-check/run.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const standalone = join(here, '..', '..');
const current = JSON.parse(readFileSync(join(standalone, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
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
  for (const [name, version] of [
    ['mama-os', previous],
    ['mama-core', core],
  ]) {
    const installed = JSON.parse(
      readFileSync(join(install, 'node_modules', '@jungjaehoon', name, 'package.json'), 'utf8')
    ).version;
    if (installed !== version) {
      throw new Error(`npm installed ${name} ${installed}, not ${version}`);
    }
  }
  copyFileSync(join(here, 'writer.mjs'), join(install, 'writer.mjs'));

  const home = join(root, 'home');
  mkdirSync(join(home, 'vault'), { recursive: true });
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, 'members'));
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
  // MAMA needs its backend on PATH to boot. The check runs no model: this stand-in exits at once,
  // so the turn started for the pending message ends there, and a real backend is never started.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho "upgrade check: no backend" >&2\nexit 1\n');
  chmodSync(join(bin, 'codex'), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  // Each release writes its own database path into the config, and work cannot be written with
  // embeddings switched off.
  delete env.MAMA_DB_PATH;
  delete env.MAMA_FORCE_TIER_3;
  const written = join(root, 'written.json');

  run(process.execPath, [join(install, 'writer.mjs'), written], {
    cwd: install,
    stdio: 'inherit',
    env: {
      ...env,
      MAMA_API_PORT: String(await freePort()),
      MAMA_UPGRADE_TOOLS: join(root, 'tools'),
      MAMA_UPGRADE_MEMBERS: join(root, 'members'),
    },
  });
  run(process.execPath, [join(here, 'reader.mjs'), written], {
    stdio: 'inherit',
    env: { ...env, MAMA_API_PORT: String(await freePort()) },
  });

  const doctor = spawnSync(
    process.execPath,
    [join(standalone, 'dist', 'cli', 'index.js'), 'doctor', '--json', '--offline'],
    { encoding: 'utf8', env }
  );
  const checks = JSON.parse(doctor.stdout).checks;
  for (const name of ['config', 'schema']) {
    const check = checks.find((entry) => entry.name === name);
    if (check?.status !== 'ok') {
      throw new Error(`doctor ${name}: ${JSON.stringify(check)}`);
    }
  }
  const schema = checks.find((entry) => entry.name === 'schema').detail;
  if (/migrates/.test(schema)) {
    throw new Error(`doctor schema is not migrated: ${schema}`);
  }
  console.log(`upgrade check: doctor config ok, schema ${schema}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
