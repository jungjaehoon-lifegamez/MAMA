/**
 * A local npm registry (verdaccio) that serves this build, for the checks that install MAMA OS the
 * way an owner's npm would: the update leg (upgrade-check/update.mjs) and the install command's
 * leg (install-check/run.mjs). This build is packed as it would be published and renumbered into
 * the versions a check names; mama-core is served as this checkout's, and everything else is
 * proxied from npmjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const standalone = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(standalone, '..', 'mama-core');
export const NAME = '@jungjaehoon/mama-os';
/** Pinned: the registry is part of the check, not something it follows. */
export const VERDACCIO = 'verdaccio@6.11.1';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 900_000, ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
  return result.stdout ?? '';
}

export const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

export async function until(what, check, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${what}: not within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Start verdaccio in `dir` and publish this build's mama-core, and this build's mama-os once per
 * entry of `versions`, renumbered; an entry with `crash` exits at boot. The caller kills `server`.
 *
 * @param {{ dir: string, versions: Array<{ version: string, crash?: boolean }> }} options
 * @returns {Promise<{ registry: string, server: import('node:child_process').ChildProcess }>}
 */
export async function serveThisBuild({ dir, versions }) {
  // pnpm writes core's version where the workspace names `workspace:*`.
  const pack = (cwd, name) => {
    const out = join(dir, 'packs', name);
    mkdirSync(out, { recursive: true });
    run('pnpm', ['pack', '--pack-destination', out], { cwd });
    return join(
      out,
      readdirSync(out).find((file) => file.endsWith('.tgz'))
    );
  };
  const corePack = pack(core, 'core');
  const osPack = pack(standalone, 'os');
  const variants = [];
  for (const { version, crash = false } of versions) {
    const folder = join(dir, 'variants', version);
    mkdirSync(folder, { recursive: true });
    run('tar', ['xzf', osPack, '-C', folder]);
    const manifestPath = join(folder, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (crash) {
      const cli = join(folder, 'package', 'dist', 'cli', 'index.js');
      const [shebang, ...rest] = readFileSync(cli, 'utf8').split('\n');
      writeFileSync(
        cli,
        [
          shebang,
          "if (process.argv[2] === 'daemon') { console.error('upgrade check: this candidate exits at boot'); process.exit(1); }",
          ...rest,
        ].join('\n')
      );
    }
    variants.push(
      join(
        folder,
        run('npm', ['pack', join(folder, 'package'), '--pack-destination', folder, '--silent'])
          .trim()
          .split('\n')
          .pop()
      )
    );
  }

  // The registry: our scope only from here, the rest proxied from npmjs.
  const port = await freePort();
  const registry = `http://127.0.0.1:${port}`;
  const verdaccioRoot = join(dir, 'verdaccio');
  mkdirSync(verdaccioRoot);
  writeFileSync(
    join(verdaccioRoot, 'config.yaml'),
    [
      `storage: ${JSON.stringify(join(verdaccioRoot, 'storage'))}`,
      'auth:',
      '  htpasswd:',
      `    file: ${JSON.stringify(join(verdaccioRoot, 'htpasswd'))}`,
      '    max_users: 1',
      'uplinks:',
      '  npmjs:',
      '    url: https://registry.npmjs.org/',
      'packages:',
      "  '@jungjaehoon/*':",
      '    access: $all',
      '    publish: $authenticated',
      "  '**':",
      '    access: $all',
      '    publish: $authenticated',
      '    proxy: npmjs',
      'log: { type: stdout, format: pretty, level: warn }',
      '',
    ].join('\n')
  );
  const server = spawn(
    'npx',
    [
      '--yes',
      VERDACCIO,
      '--config',
      join(verdaccioRoot, 'config.yaml'),
      '--listen',
      `127.0.0.1:${port}`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, HOME: homedir() } }
  );
  try {
    await until(
      'verdaccio answers',
      async () => (await fetch(`${registry}/-/ping`).catch(() => null))?.ok === true,
      180_000
    );
    const user = await (
      await fetch(`${registry}/-/user/org.couchdb.user:upgrade-check`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'upgrade-check', password: 'upgrade-check' }),
      })
    ).json();
    if (typeof user.token !== 'string') {
      throw new Error(`verdaccio gave no token: ${JSON.stringify(user)}`);
    }
    const publishRc = join(dir, 'publish.npmrc');
    writeFileSync(publishRc, `//127.0.0.1:${port}/:_authToken=${user.token}\n`, { mode: 0o600 });
    for (const tarball of [corePack, ...variants]) {
      run('npm', ['publish', tarball, '--registry', registry, '--userconfig', publishRc], {
        stdio: 'inherit',
      });
    }
  } catch (error) {
    server.kill();
    throw error;
  }
  return { registry, server };
}
