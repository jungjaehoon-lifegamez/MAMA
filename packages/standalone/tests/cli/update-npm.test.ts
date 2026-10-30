/**
 * `mama update` with the real npm beside this Node, against a registry served from this process:
 * the registry npm's own settings name, the staged install, the swap of a package that carries its
 * own node_modules, and `npm ls -g` after a rollback. Packages are small fixtures with the real
 * package's name; the service, the daemon and backup stay stand-ins (tests/helpers/update-install.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCredentialEnvName } from '../../src/runtime/backend-security.js';
import { expectClean, fixture, NAME, roots } from '../helpers/update-install.js';

const NODE = process.execPath;
const NPM = join(dirname(NODE), 'npm');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'mama-update-npm-')));
/** Each npm child's environment names, PATH and Node, as its install script saw them. */
const seen = join(work, 'seen.jsonl');
const packuments = new Map<string, Record<string, unknown>>();
let registryProcess: ChildProcess;
let registry: string;

/** Pack a fixture package the way npm publishes one, and serve it. */
function publish(
  name: string,
  version: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>
) {
  const folder = join(work, 'src', `${name.replace('/', '+')}-${version}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, version, ...manifest }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text, { mode: 0o755 });
  }
  const out = join(work, 'packed');
  mkdirSync(out, { recursive: true });
  const file = execFileSync(NPM, ['pack', folder, '--pack-destination', out, '--silent'], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(work, 'cache') },
  }).trim();
  const tgz = readFileSync(join(out, file));
  const key = `${name.replace('/', '-')}-${version}.tgz`;
  mkdirSync(join(work, 'tarballs'), { recursive: true });
  writeFileSync(join(work, 'tarballs', key), tgz);
  const packument = packuments.get(name) ?? { name, versions: {}, 'dist-tags': {} };
  (packument.versions as Record<string, unknown>)[version] = {
    name,
    version,
    ...manifest,
    dist: {
      tarball: `${registry}/-/${key}`,
      shasum: createHash('sha1').update(tgz).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
    },
  };
  (packument['dist-tags'] as Record<string, string>).latest = version;
  packuments.set(name, packument);
  mkdirSync(join(work, 'packuments'), { recursive: true });
  writeFileSync(
    join(work, 'packuments', `${encodeURIComponent(name)}.json`),
    JSON.stringify(packument)
  );
}

function mamaOs(version: string) {
  const dump = `require('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ names: Object.keys(process.env), path: process.env.PATH }) + '\\n');`;
  publish(
    NAME,
    version,
    {
      bin: { mama: './dist/cli/index.js', 'mama-os': './dist/cli/index.js' },
      dependencies: { 'mama-update-fixture-dep': '1.0.0' },
      scripts: { preinstall: 'node dump.js' },
    },
    {
      'dump.js': dump,
      // Runs through the bin link, from its own folder's node_modules.
      'dist/cli/index.js': `#!/usr/bin/env node\nconsole.log(require('mama-update-fixture-dep') + ' ' + require('../../package.json').version);\n`,
    }
  );
}

/**
 * The registry, in its own process: the npm calls below run synchronously, which would stop a
 * server in this one. It serves the packuments and tarballs written under `work`.
 */
const REGISTRY = `
const { createServer } = require('node:http');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const [dir] = process.argv.slice(1);
const server = createServer((request, response) => {
  const url = decodeURIComponent(request.url || '');
  const name = url.startsWith('/-/') ? join('tarballs', url.slice(3)) : join('packuments', encodeURIComponent(url.slice(1)) + '.json');
  const path = join(dir, name);
  if (!existsSync(path)) { response.writeHead(404); response.end('{}'); return; }
  response.writeHead(200, { 'content-type': url.startsWith('/-/') ? 'application/octet-stream' : 'application/json' });
  response.end(readFileSync(path));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

beforeAll(async () => {
  registryProcess = spawn(NODE, ['-e', REGISTRY, work], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((resolve) =>
    registryProcess.stdout!.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()))
  );
  registry = `http://127.0.0.1:${port}`;
  publish(
    'mama-update-fixture-dep',
    '1.0.0',
    { main: 'index.js' },
    {
      'index.js': "module.exports = 'dep';\n",
    }
  );
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) mamaOs(version);
}, 120_000);

afterAll(() => {
  registryProcess.kill();
  rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(seen, { force: true });
});

/** The owner's npm settings: the local registry, and a cache of this run's own. */
const npmSettings = () => ({
  npm_config_registry: registry,
  npm_config_cache: join(work, 'cache'),
});

/** An install npm made at `<prefix>`. */
function npmInstall(version: string) {
  return (prefix: string) => {
    execFileSync(
      NPM,
      ['install', '-g', '--prefix', prefix, `${NAME}@${version}`, '--no-audit', '--no-fund'],
      { env: { ...process.env, ...npmSettings() }, stdio: 'pipe' }
    );
  };
}

const bin = (f: { prefix: string }) =>
  execFileSync(NODE, [join(f.prefix, 'bin', 'mama')], { encoding: 'utf8' }).trim();
const listed = (f: { prefix: string }) =>
  (
    JSON.parse(
      execFileSync(NPM, ['ls', '-g', '--prefix', f.prefix, '--depth=0', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, ...npmSettings() },
      })
    ) as { dependencies: Record<string, { version: string }> }
  ).dependencies[NAME]?.version;

describe('mama update with npm', { timeout: 180_000 }, () => {
  it('stages from the prefix registry, swaps a package that runs from its new place, and rolls back', async () => {
    const f = fixture({
      releases: { '1.2.0': { installFails: true } },
      latest: '1.2.0',
      realNpm: { nodePath: NODE, install: npmInstall('1.0.0') },
      env: npmSettings(),
    });
    expect(bin(f)).toBe('dep 1.0.0');
    rmSync(seen, { force: true });

    expect(await f.run(['1.1.0'])).toBe(0);
    expect(f.output()).toContain(`registry: ${registry}`);
    expectClean(f, '1.1.0');
    // The bin link npm made for 1.0.0 runs 1.1.0, from the swapped folder's own node_modules.
    expect(bin(f)).toBe('dep 1.1.0');
    expect(listed(f)).toBe('1.1.0');
    // npm's install script saw no credential name, and the pinned Node's folder first on PATH.
    const runs = readFileSync(seen, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { names: string[]; path: string });
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.names.filter(isCredentialEnvName)).toEqual([]);
      // npm puts its own and the package's .bin folders ahead; the owner's PATH follows.
      expect(run.path.split(':').filter((entry) => !entry.includes('/node_modules/'))[0]).toBe(
        dirname(NODE)
      );
    }

    // 1.2.0 fails at step 10; npm ls -g shows 1.1.0 again.
    expect(await f.run([])).toBe(1);
    expect(f.output()).toContain('rolled back: 1.1.0 runs again; step 10 of the update to 1.2.0');
    expectClean(f, '1.1.0');
    expect(listed(f)).toBe('1.1.0');
    expect(bin(f)).toBe('dep 1.1.0');
    expect(readdirSync(f.scope)).toEqual(['mama-os']);
  });
});
