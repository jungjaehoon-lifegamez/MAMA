/**
 * MAMA OS daemon spawn and watchdog logic.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { writePid, isProcessRunning } from '../utils/pid-manager.js';
import { API_PORT } from './utilities.js';

/**
 * Watchdog configuration
 */
export const WATCHDOG = {
  /** Health check interval (ms) */
  CHECK_INTERVAL: 30_000,
  /** Max consecutive failures before restart */
  MAX_FAILURES: 3,
  /** Health check HTTP timeout (ms) */
  HEALTH_TIMEOUT: 5_000,
  /** Max auto-restarts before giving up */
  MAX_RESTARTS: 10,
  /** Backoff multiplier per restart (ms) */
  BACKOFF_BASE: 2_000,
  /** Max backoff delay (ms) */
  BACKOFF_MAX: 60_000,
};

/**
 * Spawn a daemon child process and return its PID
 */
export function spawnDaemonChild(): number {
  const logDir = `${homedir()}/.mama/logs`;
  mkdirSync(logDir, { recursive: true });

  const logFile = `${logDir}/daemon.log`;
  const out = openSync(logFile, 'a');

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  delete cleanEnv.CLAUDE_CODE_SSE_PORT;

  const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: homedir(),
    env: {
      ...cleanEnv,
      MAMA_DAEMON: '1',
      MAMA_LOG_LEVEL: process.env.MAMA_LOG_LEVEL || 'INFO',
    },
  });

  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn daemon process');
  }

  return child.pid;
}

/**
 * Start daemon process with watchdog auto-restart
 */
export async function startDaemon(): Promise<number> {
  const pid = spawnDaemonChild();

  // Give the child a short window to fail fast before we advertise it as healthy.
  // Without this, a dead-on-start daemon can still get a PID file + watchdog while
  // an old daemon is serving health, which leads to duplicate gateways on restart.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (!isProcessRunning(pid)) {
    throw new Error(`Daemon process ${pid} exited before startup completed`);
  }
  await writePid(pid);

  // Start watchdog in background (detached)
  startWatchdog(pid);

  return pid;
}

/**
 * Watchdog: monitors daemon health and auto-restarts on failure.
 * Runs as a background interval in the parent process (which exits shortly after).
 * To survive parent exit, we spawn a separate watchdog process.
 */
export function startWatchdog(initialPid: number): void {
  const logDir = `${homedir()}/.mama/logs`;
  mkdirSync(logDir, { recursive: true });
  const logFile = `${logDir}/daemon.log`;
  const out = openSync(logFile, 'a');

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  delete cleanEnv.CLAUDE_CODE_SSE_PORT;

  const watchdogScript = `
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const os = require('node:os');

const API_PORT = ${API_PORT};
const CHECK_INTERVAL = ${WATCHDOG.CHECK_INTERVAL};
const MAX_FAILURES = ${WATCHDOG.MAX_FAILURES};
const HEALTH_TIMEOUT = ${WATCHDOG.HEALTH_TIMEOUT};
const MAX_RESTARTS = ${WATCHDOG.MAX_RESTARTS};
const BACKOFF_BASE = ${WATCHDOG.BACKOFF_BASE};
const BACKOFF_MAX = ${WATCHDOG.BACKOFF_MAX};
const DAEMON_CMD = ${JSON.stringify(process.argv[1])};
const NODE_PATH = ${JSON.stringify(process.execPath)};
const pidPath = require('node:path').join(os.homedir(), '.mama', 'mama.pid');

let currentPid = ${initialPid};
let failures = 0;
let restartCount = 0;

function log(msg) {
  const ts = new Date().toISOString();
  const line = '[' + ts + '] [Watchdog] ' + msg + '\\n';
  try { fs.appendFileSync(${JSON.stringify(logFile)}, line); } catch {}
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:' + API_PORT + '/health', { timeout: HEALTH_TIMEOUT }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).status === 'ok'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function spawnDaemon() {
  const logDir = require('node:path').join(os.homedir(), '.mama', 'logs');
  const out = fs.openSync(require('node:path').join(logDir, 'daemon.log'), 'a');
  const env = Object.assign({}, process.env, { MAMA_DAEMON: '1' });
  const child = spawn(NODE_PATH, [DAEMON_CMD, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: os.homedir(),
    env,
  });
  child.unref();
  return child.pid;
}

async function tick() {
  // If our tracked PID is dead, check if another daemon is alive via PID file.
  // This handles the case where a Watchdog-spawned daemon failed (e.g. port conflict)
  // but the original daemon is still running fine.
  let alive = isRunning(currentPid);
  if (!alive) {
    try {
      const pidData = JSON.parse(fs.readFileSync(pidPath, 'utf-8'));
      if (pidData.pid && pidData.pid !== currentPid && isRunning(pidData.pid)) {
        log('Tracked PID ' + currentPid + ' is dead, but PID file daemon ' + pidData.pid + ' is alive. Adopting.');
        currentPid = pidData.pid;
        alive = true;
        failures = 0;
      }
    } catch {}
  }
  if (!alive) {
    // Also check if port 3847 is responding — another daemon instance may be serving
    const healthy = await checkHealth();
    if (healthy) {
      log('Tracked PID ' + currentPid + ' is dead, but health check passed. Skipping restart.');
      failures = 0;
      return;
    }
    log('Daemon process ' + currentPid + ' not found (dead)');
    failures = MAX_FAILURES; // trigger immediate restart
  } else {
    const healthy = await checkHealth();
    if (healthy) {
      failures = 0;
      return;
    }
    failures++;
    log('Health check failed (' + failures + '/' + MAX_FAILURES + ')');
  }

  if (failures >= MAX_FAILURES) {
    if (restartCount >= MAX_RESTARTS) {
      log('Max restarts (' + MAX_RESTARTS + ') reached. Watchdog giving up.');
      process.exit(1);
    }

    const backoff = Math.min(BACKOFF_BASE * Math.pow(2, restartCount), BACKOFF_MAX);
    log('Restarting daemon (attempt ' + (restartCount + 1) + '/' + MAX_RESTARTS + ', backoff ' + backoff + 'ms)');

    // Kill old process if still lingering — wait 5s for graceful shutdown
    // (Discord/Slack disconnect + session cleanup can take several seconds)
    if (isRunning(currentPid)) {
      try { process.kill(currentPid, 'SIGTERM'); } catch {}
      await new Promise(r => setTimeout(r, 5000));
      if (isRunning(currentPid)) {
        try { process.kill(currentPid, 'SIGKILL'); } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await new Promise(r => setTimeout(r, backoff));

    const newPid = spawnDaemon();
    if (!newPid) {
      log('Failed to spawn new daemon');
      restartCount++;
      return;
    }

    currentPid = newPid;
    restartCount++;
    failures = 0;

    // Update PID file
    const pidInfo = JSON.stringify({ pid: newPid, startedAt: Date.now() }, null, 2);
    try { fs.writeFileSync(pidPath, pidInfo, 'utf-8'); } catch {}

    log('Daemon restarted with PID ' + newPid);

    // Wait for startup
    await new Promise(r => setTimeout(r, 5000));
  }
}

// Reset restart count if daemon stays healthy for 10 minutes
setInterval(() => {
  if (failures === 0 && restartCount > 0) {
    log('Daemon stable — resetting restart counter');
    restartCount = 0;
  }
}, 10 * 60 * 1000);

log('Started (monitoring PID ' + currentPid + ', check every ' + (CHECK_INTERVAL / 1000) + 's)');

setInterval(() => tick(), CHECK_INTERVAL);

// Initial check after 10s (give daemon time to boot)
setTimeout(() => tick(), 10000);
`;

  // Spawn watchdog as a separate detached process
  const child = spawn(process.execPath, ['-e', watchdogScript, 'mama-watchdog'], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: homedir(),
    env: {
      ...cleanEnv,
      MAMA_WATCHDOG: '1',
    },
  });

  child.unref();

  // Save watchdog PID alongside daemon PID
  const watchdogPidPath = `${homedir()}/.mama/watchdog.pid`;
  writeFileSync(
    watchdogPidPath,
    JSON.stringify({ pid: child.pid, startedAt: Date.now() }, null, 2)
  );
}
