/**
 * The update leg (docs/development/work/update.md, PR 3): a local registry (verdaccio) serves
 * this build as N and N+1, and an N+2 that exits at boot. On the install run.mjs set up, N is
 * installed globally under a temp prefix and started through a stand-in service manager
 * (fake-service.cjs); `mama update` then goes N → N+1, and N+1 → N+2 rolls back to N+1.
 *
 * What it proves: the npm flow (the registry npm's settings name, the staged install, the swap of
 * a package that holds its own node_modules), the journal, the candidate's held boot, the
 * rollback and `npm ls -g`, with the real CLI and the real daemon. What it does not: launchd or
 * systemd themselves (KeepAlive, a restart after a crash, bootstrapping a job); the stand-in
 * neither restarts nor supervises. That half is the clean-account proof the spec names.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const standalone = join(here, '..', '..');
const core = join(standalone, '..', 'mama-core');
const require = createRequire(join(standalone, 'package.json'));
const Database = require('better-sqlite3');
const yaml = require('js-yaml');
const NAME = '@jungjaehoon/mama-os';
/** Pinned: the registry is part of the check, not something it follows. */
const VERDACCIO = 'verdaccio@6.11.1';

function run(command, args, options = {}) {
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

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function until(what, check, timeoutMs) {
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

function expect(ok, message) {
  if (!ok) {
    throw new Error(`update leg: ${message}`);
  }
}

/**
 * @param {{ root: string, home: string, env: NodeJS.ProcessEnv }} install run.mjs's temp root,
 *   the HOME its writer and reader used, and their environment (the backend stand-in on PATH).
 */
export async function updateLeg({ root, home, env }) {
  const current = JSON.parse(readFileSync(join(standalone, 'package.json'), 'utf8')).version;
  const [major, minor, patch] = current.split('.').map(Number);
  const N = current;
  const N1 = `${major}.${minor}.${patch + 1}`;
  const N2 = `${major}.${minor}.${patch + 2}`;
  const leg = join(root, 'update');
  mkdirSync(leg);
  const children = [];

  try {
    // This build, packed as it would be published; N+1 and N+2 are the same build renumbered,
    // and N+2's daemon exits at boot.
    // pnpm writes core's version where the workspace names `workspace:*`.
    const pack = (cwd, name) => {
      const out = join(leg, 'packs', name);
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
    for (const [version, crash] of [
      [N, false],
      [N1, false],
      [N2, true],
    ]) {
      const folder = join(leg, 'variants', version);
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
    const verdaccioRoot = join(leg, 'verdaccio');
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
    const verdaccio = spawn(
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
    children.push(verdaccio);
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
    expect(typeof user.token === 'string', `verdaccio gave no token: ${JSON.stringify(user)}`);
    const publishRc = join(leg, 'publish.npmrc');
    writeFileSync(publishRc, `//127.0.0.1:${port}/:_authToken=${user.token}\n`, { mode: 0o600 });
    for (const pack of [corePack, ...variants]) {
      run('npm', ['publish', pack, '--registry', registry, '--userconfig', publishRc], {
        stdio: 'inherit',
      });
    }
    console.log(`update leg: ${registry} serves ${NAME} ${N}, ${N1}, ${N2} (exits at boot)`);

    // The owner's npm names this registry; the npm cache is the machine's, as run.mjs's is.
    const npmSettings = {
      npm_config_registry: registry,
      npm_config_cache: join(homedir(), '.npm'),
      npm_config_update_notifier: 'false',
    };
    const prefix = join(leg, 'prefix');
    run('npm', ['install', '-g', '--prefix', prefix, `${NAME}@${N}`, '--no-audit', '--no-fund'], {
      env: { ...env, ...npmSettings },
      stdio: 'inherit',
    });

    // The stand-ins: a service manager first on PATH, and the Bot API.
    const fakes = join(leg, 'fakes');
    mkdirSync(fakes);
    for (const tool of ['launchctl', 'systemctl']) {
      writeFileSync(
        join(fakes, tool),
        `#!/bin/sh\nexec '${process.execPath}' '${join(here, 'fake-service.cjs')}' ${tool} "$@"\n`
      );
      chmodSync(join(fakes, tool), 0o755);
    }
    const portFile = join(leg, 'telegram.port');
    children.push(
      spawn(process.execPath, [join(here, 'fake-telegram.cjs'), 'serve', portFile], {
        stdio: 'inherit',
      })
    );
    const telegramPort = await until(
      'the Bot API stand-in listens',
      () => existsSync(portFile) && readFileSync(portFile, 'utf8'),
      30_000
    );
    const mamaEnv = {
      ...env,
      ...npmSettings,
      PATH: `${fakes}:${env.PATH}`,
      // Both waits (N+1's boot, and N+2's, which never comes): five minutes, not the owner's ten,
      // and still room for a cold runner to load the embedding model.
      MAMA_UPDATE_WAIT_MS: '300000',
    };
    // The unit file goes under this HOME, where the stand-in looks.
    delete mamaEnv.XDG_CONFIG_HOME;
    // On this Mac the real launchctl would act on the owner's own daemon: refuse unless the
    // stand-in is the one found.
    expect(
      spawnSync('launchctl', ['fake-check'], { env: mamaEnv, encoding: 'utf8' }).stdout?.trim() ===
        'fake',
      'the stand-in service manager is not first on PATH'
    );
    const mamaRoot = join(home, '.mama');
    const viewerPort = await freePort();
    // What mama service install carries over: the viewer's port, and the Bot API stand-in.
    writeFileSync(
      join(mamaRoot, 'start.sh'),
      [
        '#!/bin/sh',
        '# Written by mama init or mama service install; mama service install rewrites it.',
        `export MAMA_API_PORT='${viewerPort}'`,
        `export NODE_OPTIONS='--require ${join(here, 'fake-telegram.cjs')}'`,
        `export MAMA_FAKE_TELEGRAM_PORT='${telegramPort}'`,
        '',
      ].join('\n'),
      { mode: 0o700 }
    );
    const cli = join(prefix, 'bin', 'mama');
    const mama = (args, options = {}) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: mamaEnv,
        encoding: 'utf8',
        timeout: 900_000,
        ...options,
      });
      if (result.error) {
        throw result.error;
      }
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      console.log(output.trimEnd().replace(/^/gm, `  mama ${args.join(' ')} | `));
      return { status: result.status, output };
    };
    const status = () => {
      const result = spawnSync(process.execPath, [cli, 'status', '--json'], {
        env: mamaEnv,
        encoding: 'utf8',
      });
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    };
    const runsAt = (version) =>
      until(
        `the daemon runs ${version}`,
        () => {
          const now = status();
          return now?.state === 'running' &&
            now.status.stage === 'running' &&
            now.status.version === version
            ? now
            : null;
        },
        300_000
      );
    const listed = () =>
      JSON.parse(
        run('npm', ['ls', '-g', '--prefix', prefix, '--depth=0', '--json'], {
          env: { ...env, ...npmSettings },
        })
      ).dependencies?.[NAME]?.version;
    const config = yaml.load(readFileSync(join(mamaRoot, 'config.yaml'), 'utf8'));
    const inputs = () => {
      const db = new Database(config.database.path, { readonly: true });
      try {
        return db.prepare('SELECT COUNT(*) AS count FROM mailbox_inputs').get().count;
      } finally {
        db.close();
      }
    };
    const scope = join(prefix, 'lib', 'node_modules', '@jungjaehoon');
    const clean = (version) => {
      expect(listed() === version, `npm ls -g shows ${listed()}, not ${version}`);
      expect(!existsSync(join(mamaRoot, 'runtime', 'update.json')), 'the journal is still open');
      expect(!existsSync(join(mamaRoot, 'runtime', 'update.hold')), 'the hold file is still there');
      const backups = existsSync(join(mamaRoot, 'backups'))
        ? readdirSync(join(mamaRoot, 'backups'))
        : [];
      expect(
        !backups.some((name) => name.startsWith('mama-update-')),
        `a snapshot is left: ${backups}`
      );
      expect(
        JSON.stringify(readdirSync(scope)) === JSON.stringify(['mama-os']),
        `the scope folder holds ${readdirSync(scope)}`
      );
    };

    // N, run by its service.
    expect(mama(['service', 'install']).status === 0, 'mama service install failed');
    expect(mama(['service', 'start']).status === 0, 'mama service start failed');
    await runsAt(N);

    const dry = mama(['update', N1, '--dry-run']);
    expect(dry.status === 0 && dry.output.includes(`${NAME} ${N} → ${N1}`), 'the dry run');
    expect(listed() === N, 'the dry run changed the install');

    const up = mama(['update', N1]);
    expect(up.status === 0 && up.output.includes(`updated: ${N} → ${N1}`), 'the update to N+1');
    const after = await runsAt(N1);
    expect(after.status.update === null, 'N+1 still holds its claims');
    clean(N1);
    expect(mama(['update', N1]).output.includes(`already on ${N1}`), 'the same version');

    const before = inputs();
    const down = mama(['update', N2]);
    expect(down.status === 1, `the update to N+2 exited ${down.status}`);
    expect(
      down.output.includes(`rolled back: ${N1} runs again; step 14 of the update to ${N2}`),
      'the rollback report'
    );
    expect(
      down.output.includes(`the database was kept: ${N2} did not migrate it`),
      'the database kept'
    );
    await runsAt(N1);
    clean(N1);
    expect(inputs() === before, `inputs ${before} before, ${inputs()} after`);
    console.log(
      `update leg: ${N} → ${N1} updated; ${N1} → ${N2} rolled back to ${N1}; npm ls -g ${listed()}`
    );

    expect(mama(['stop']).status === 0, 'mama stop');
  } finally {
    for (const child of children) {
      child.kill();
    }
    // A daemon a failed step left running.
    spawnSync(
      process.execPath,
      [join(here, 'fake-service.cjs'), 'systemctl', '--user', 'stop', 'mama.service'],
      {
        env: { ...env, HOME: home },
      }
    );
  }
}
