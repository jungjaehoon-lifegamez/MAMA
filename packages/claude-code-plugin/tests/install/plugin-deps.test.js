/**
 * The plugin installs its npm dependencies into Claude Code's plugin data directory.
 *
 * Claude Code copies a marketplace plugin without running npm install and replaces the copy on
 * every update, so the hooks had no mama-core. SessionStart installs it into CLAUDE_PLUGIN_DATA,
 * which survives updates; a development checkout keeps using its own node_modules.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const { ensurePluginDependencies } = require(path.join(PLUGIN_ROOT, 'scripts', 'plugin-deps.js'));

/** A plugin copy as the marketplace ships it: package.json and no node_modules. */
function marketplaceCopy(dependencies = { '@jungjaehoon/mama-core': '^5.0.0' }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-plugin-deps-'));
  const root = path.join(base, 'plugin');
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@jungjaehoon/mama-plugin',
      scripts: { postinstall: 'node scripts/postinstall.js' },
      dependencies,
    })
  );
  return { root, dataDir: path.join(base, 'data') };
}

/** Stands in for npm: records the calls and writes mama-core where npm would. */
function fakeNpm() {
  const calls = [];
  const install = (dir) => {
    calls.push(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')));
    const core = path.join(dir, 'node_modules', '@jungjaehoon', 'mama-core');
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(core, 'package.json'), '{}');
  };
  return { calls, install };
}

describe('plugin dependencies in CLAUDE_PLUGIN_DATA', () => {
  it('installs the dependencies once and only the dependencies', () => {
    const { root, dataDir } = marketplaceCopy();
    const npm = fakeNpm();
    expect(ensurePluginDependencies({ root, dataDir, install: npm.install })).toBe('installed');
    // The plugin's postinstall runs relative to its own folder, so it is not copied.
    expect(npm.calls).toEqual([
      {
        name: 'mama-plugin-dependencies',
        private: true,
        dependencies: { '@jungjaehoon/mama-core': '^5.0.0' },
      },
    ]);
    expect(ensurePluginDependencies({ root, dataDir, install: npm.install })).toBe('ready');
    expect(npm.calls).toHaveLength(1);
  });

  it('installs again when the plugin update changes its dependencies', () => {
    const { root, dataDir } = marketplaceCopy();
    const npm = fakeNpm();
    ensurePluginDependencies({ root, dataDir, install: npm.install });
    const updated = marketplaceCopy({ '@jungjaehoon/mama-core': '^6.0.0' }).root;
    expect(ensurePluginDependencies({ root: updated, dataDir, install: npm.install })).toBe(
      'installed'
    );
    expect(npm.calls.map((call) => call.dependencies['@jungjaehoon/mama-core'])).toEqual([
      '^5.0.0',
      '^6.0.0',
    ]);
  });

  it('retries at the next start when npm failed or was stopped midway', () => {
    const { root, dataDir } = marketplaceCopy();
    const failing = () => {
      throw new Error('npm install exited 1');
    };
    expect(() => ensurePluginDependencies({ root, dataDir, install: failing })).toThrow(
      'npm install exited 1'
    );
    // A partial tree without the success marker is installed again.
    const core = path.join(dataDir, 'node_modules', '@jungjaehoon', 'mama-core');
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(core, 'package.json'), '{}');
    const npm = fakeNpm();
    expect(ensurePluginDependencies({ root, dataDir, install: npm.install })).toBe('installed');
    expect(fs.existsSync(path.join(dataDir, 'install.lock'))).toBe(false);
  });

  /** A lock as another session leaves it: a folder holding its owner's pid. */
  function lockBy(dataDir, pid) {
    const lock = path.join(dataDir, 'install.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner'), `${pid} other`);
    return lock;
  }
  const LIVE = 4242;
  const DEAD = 4343;
  const isAlive = (pid) => pid !== DEAD;

  it('leaves an install in progress alone, and takes over a lock whose owner died', () => {
    const { root, dataDir } = marketplaceCopy();
    const lock = lockBy(dataDir, LIVE);
    const npm = fakeNpm();
    expect(() =>
      ensurePluginDependencies({ root, dataDir, install: npm.install, isAlive })
    ).toThrow(/another session is installing/);
    expect(npm.calls).toHaveLength(0);
    fs.rmSync(lock, { recursive: true });
    lockBy(dataDir, DEAD);
    expect(ensurePluginDependencies({ root, dataDir, install: npm.install, isAlive })).toBe(
      'installed'
    );
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(dataDir).filter((name) => name.includes('lock'))).toEqual([]);
  });

  it('gives back a live lock another session took over first', () => {
    const { root, dataDir } = marketplaceCopy();
    const lock = lockBy(dataDir, DEAD);
    const npm = fakeNpm();
    // Both sessions saw the dead owner; the other one recovered first and holds a live lock.
    const otherRecoversFirst = () => {
      fs.rmSync(lock, { recursive: true });
      lockBy(dataDir, LIVE);
    };
    expect(() =>
      ensurePluginDependencies({
        root,
        dataDir,
        install: npm.install,
        isAlive,
        beforeTakeover: otherRecoversFirst,
      })
    ).toThrow(/another session is installing/);
    expect(npm.calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe(`${LIVE} other`);
  });

  it('removes only its own lock', () => {
    const { root, dataDir } = marketplaceCopy();
    const lock = path.join(dataDir, 'install.lock');
    const npm = fakeNpm();
    // While this session installs, its lock is replaced by another session's.
    const replacedWhileInstalling = (dir) => {
      fs.rmSync(lock, { recursive: true });
      lockBy(dataDir, LIVE);
      npm.install(dir);
    };
    ensurePluginDependencies({ root, dataDir, install: replacedWhileInstalling, isAlive });
    expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe(`${LIVE} other`);
  });

  it('installs nothing for a checkout whose own node_modules has mama-core', () => {
    const npm = fakeNpm();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-plugin-data-'));
    expect(ensurePluginDependencies({ root: PLUGIN_ROOT, dataDir, install: npm.install })).toBe(
      'local'
    );
    expect(npm.calls).toHaveLength(0);
  });

  it('says so when Claude Code gave no data directory', () => {
    const { root } = marketplaceCopy();
    expect(() =>
      ensurePluginDependencies({ root, dataDir: '', install: fakeNpm().install })
    ).toThrow(/CLAUDE_PLUGIN_DATA is not set/);
  });
});
