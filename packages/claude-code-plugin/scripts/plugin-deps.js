/**
 * Where the plugin's npm dependencies live, and installing them there.
 *
 * Claude Code copies a marketplace plugin without running npm install and replaces the copy on
 * every update. ${CLAUDE_PLUGIN_DATA} is kept across updates, so SessionStart installs the
 * dependencies there, and every hook command puts its node_modules on NODE_PATH. A development
 * checkout has mama-core in its own node_modules, which Node searches before NODE_PATH, so
 * nothing is installed for it.
 *
 * @module plugin-deps
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PACKAGE = ['@jungjaehoon', 'mama-core'];
const MARKER = 'installed-dependencies.json';
const LOCK = 'install.lock';
const BUSY =
  'another session is installing the plugin dependencies; they are ready from the next session';
const STALE_TAKEOVER_MS = 30_000;

function hasCore(nodeModules) {
  return fs.existsSync(path.join(nodeModules, ...CORE_PACKAGE, 'package.json'));
}

/** Whether node_modules in the plugin folder, or in a folder above it, holds mama-core. */
function hasLocalCore(root) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (hasCore(path.join(dir, 'node_modules'))) {
      return true;
    }
    if (path.dirname(dir) === dir) {
      return false;
    }
  }
}

/**
 * The package.json installed in the data directory: the plugin's dependencies only. The
 * plugin's own package.json is not copied, because its postinstall runs a script relative to
 * the plugin folder.
 */
function dependencyManifest(root) {
  const { dependencies } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return `${JSON.stringify({ name: 'mama-plugin-dependencies', private: true, dependencies }, null, 2)}\n`;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function runNpmInstall(dir) {
  // Claude Code reads the SessionStart hook's stdout as its result, so npm's output stays piped.
  const result = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const tail = (result.stderr || '').trim().split('\n').slice(-5).join('\n');
    throw new Error(`npm install in ${dir} exited ${result.status}:\n${tail}`);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A directory rename onto an existing, non-empty directory fails with one of these.
const TARGET_EXISTS = ['EEXIST', 'ENOTEMPTY', 'EPERM'];

/**
 * Take the install lock: a folder holding its owner's pid and a token. Two npm installs in one
 * folder corrupt it, and sessions can start together. The lock is prepared under a unique name
 * with its owner written, then renamed into place, so no session sees a lock without an owner,
 * and a rename cannot replace a lock that exists. A lock whose owner process is gone was left by
 * a hook killed at its timeout, and is taken over. Returns the token.
 */
function acquireLock(dataDir, { isAlive, beforeTakeover }) {
  const lock = path.join(dataDir, LOCK);
  const token = `${process.pid} ${randomUUID()}`;
  const claim = () => {
    const prepared = path.join(dataDir, `${LOCK}.${randomUUID()}`);
    fs.mkdirSync(prepared);
    fs.writeFileSync(path.join(prepared, 'owner'), token);
    try {
      fs.renameSync(prepared, lock);
      return true;
    } catch (error) {
      fs.rmSync(prepared, { recursive: true, force: true });
      if (TARGET_EXISTS.includes(error.code)) {
        return false;
      }
      throw error;
    }
  };
  if (claim()) {
    return token;
  }
  const staleOwner = readText(path.join(lock, 'owner'));
  if (staleOwner === null || isAlive(Number(staleOwner.split(' ')[0]))) {
    throw new Error(BUSY);
  }
  beforeTakeover();
  // Takeovers run one at a time. Only a takeover removes a lock that another session holds, so
  // inside it a lock still naming the dead owner is the stale one.
  const takeover = path.join(dataDir, `${LOCK}.takeover`);
  try {
    fs.mkdirSync(takeover);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    // A takeover takes milliseconds; one this old was cut off, so the next session may take over.
    if (Date.now() - fs.statSync(takeover).mtimeMs > STALE_TAKEOVER_MS) {
      fs.rmSync(takeover, { recursive: true, force: true });
    }
    throw new Error(BUSY);
  }
  try {
    if (readText(path.join(lock, 'owner')) !== staleOwner) {
      throw new Error(BUSY);
    }
    fs.rmSync(lock, { recursive: true, force: true });
    if (claim()) {
      return token;
    }
    throw new Error(BUSY);
  } finally {
    fs.rmSync(takeover, { recursive: true, force: true });
  }
}

function releaseLock(dataDir, token) {
  const lock = path.join(dataDir, LOCK);
  if (readText(path.join(lock, 'owner')) === token) {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Make mama-core loadable for this session's hooks. Returns 'local' when the plugin's own
 * node_modules has it, 'ready' when the data directory holds the current dependencies, and
 * 'installed' after installing them. Throws when there is no data directory, npm fails, or
 * another session is installing.
 */
function ensurePluginDependencies({
  root = PLUGIN_ROOT,
  dataDir = process.env.CLAUDE_PLUGIN_DATA,
  install = runNpmInstall,
  isAlive = processAlive,
  beforeTakeover = () => {},
} = {}) {
  if (hasLocalCore(root)) {
    return 'local';
  }
  if (!dataDir) {
    throw new Error('CLAUDE_PLUGIN_DATA is not set, so there is no folder to install mama-core in');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const manifest = dependencyManifest(root);
  const marker = path.join(dataDir, MARKER);
  const ready = () => readText(marker) === manifest && hasCore(path.join(dataDir, 'node_modules'));
  if (ready()) {
    return 'ready';
  }

  const token = acquireLock(dataDir, { isAlive, beforeTakeover });
  try {
    // A session that held the lock before this one may have just finished.
    if (ready()) {
      return 'ready';
    }
    // The marker is written only after npm succeeds, so a stopped install is retried.
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(path.join(dataDir, 'package.json'), manifest);
    install(dataDir);
    fs.writeFileSync(marker, manifest);
    return 'installed';
  } finally {
    releaseLock(dataDir, token);
  }
}

/** For hooks that do not install: one line and exit when mama-core cannot be loaded. */
function exitUnlessCoreLoadable(hookName) {
  try {
    require.resolve('@jungjaehoon/mama-core/db-manager');
  } catch {
    console.error(
      `[MAMA ${hookName}] mama-core is not installed; the next session start installs it.`
    );
    process.exit(1);
  }
}

module.exports = { ensurePluginDependencies, exitUnlessCoreLoadable };
