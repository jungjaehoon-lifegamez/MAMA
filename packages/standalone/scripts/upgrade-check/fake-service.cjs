/**
 * A stand-in for launchctl (macOS) and systemctl --user (Linux), for the update leg only: CI has
 * no user service manager, and on a developer's Mac the real LaunchAgent label belongs to the
 * owner's own daemon. It runs `$HOME/.mama/start.sh` detached, as the service would, and answers
 * the calls MAMA makes. It does not restart a failed daemon (no KeepAlive, no Restart=): the leg
 * proves the npm flow, the journal and the rollback, not the service manager.
 *
 * Usage (through a wrapper named after the tool): launchctl print|bootstrap|kickstart|bootout ...
 *                                                 systemctl --user daemon-reload|enable|is-active|start|stop ...
 */
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [tool, ...args] = process.argv.slice(2);
const root = join(process.env.HOME, '.mama');
const state = join(process.env.HOME, '.fake-service');
mkdirSync(state, { recursive: true });
const pidFile = join(state, 'pid');
const loadedFile = join(state, 'loaded');
const log = (line) => writeFileSync(join(state, 'calls.log'), `${tool} ${line}\n`, { flag: 'a' });

function alive() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function start() {
  if (alive()) return;
  const child = spawn(join(root, 'start.sh'), [], { cwd: root, detached: true, stdio: 'ignore' });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
}

async function stop() {
  const pid = alive();
  if (pid === null) return;
  process.kill(pid, 'SIGTERM');
  // The service file's stop timeout.
  for (let waited = 0; waited < 60_000 && alive() !== null; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (alive() !== null) process.kill(pid, 'SIGKILL');
  rmSync(pidFile, { force: true });
}

async function main() {
  log(args.join(' '));
  if (args[0] === 'fake-check') {
    console.log('fake');
    return 0;
  }
  if (tool === 'launchctl') {
    const [command] = args;
    if (command === 'print') {
      if (!existsSync(loadedFile)) return 113;
      const pid = alive();
      console.log(
        `gui/${process.getuid()}/com.mama.server = {${pid === null ? '' : `\n\tpid = ${pid}`}\n}`
      );
      return 0;
    }
    if (command === 'bootstrap') {
      writeFileSync(loadedFile, '');
      start(); // RunAtLoad
      return 0;
    }
    if (command === 'kickstart') {
      start();
      return 0;
    }
    if (command === 'bootout') {
      rmSync(loadedFile, { force: true });
      await stop();
      return 0;
    }
  }
  if (tool === 'systemctl' && args[0] === '--user') {
    const [, command] = args;
    if (command === 'daemon-reload' || command === 'enable') return 0;
    if (command === 'is-active') {
      console.log(alive() === null ? 'inactive' : 'active');
      return alive() === null ? 3 : 0;
    }
    if (command === 'start') {
      start();
      return 0;
    }
    if (command === 'stop' || (command === 'disable' && args.includes('--now'))) {
      await stop();
      return 0;
    }
  }
  console.error(`fake service manager: ${tool} ${args.join(' ')} is not handled`);
  return 2;
}

main().then((code) => process.exit(code));
