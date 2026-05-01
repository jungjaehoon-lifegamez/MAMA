/**
 * mama stop command
 *
 * Stop MAMA agent daemon
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isDaemonRunning, deletePid, isProcessRunning } from '../utils/pid-manager.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('Stop');

export function isStandaloneDaemonCommand(command: string): boolean {
  const args = splitCommand(command);
  const first = args[0];
  const second = args[1];
  const third = args[2];

  return (
    (isMamaExecutable(first) && second === 'daemon') ||
    (isNodeExecutable(first) &&
      (isMamaExecutable(second) || isStandaloneCliPath(second)) &&
      third === 'daemon')
  );
}

export function isStandaloneWatchdogCommand(command: string): boolean {
  const args = splitCommand(command);
  const first = args[0];

  return (
    (isNodeExecutable(first) &&
      args.some((arg) => arg === 'mama-watchdog' || arg === '--mama-watchdog')) ||
    (isNodeExecutable(first) &&
      command.includes('DAEMON_CMD = "') &&
      command.includes('/packages/standalone/dist/cli/index.js') &&
      command.includes('function checkHealth()'))
  );
}

/**
 * Quote-aware argv split. Naive `split(/\s+/)` mangles quoted paths like
 * `node "C:\Program Files\…\index.js" daemon` and inlined `node -e "<script>"`
 * source text, which can cause stop-path checks to miss real daemons or
 * false-positive unrelated scripts. This walks the string as a small state
 * machine respecting single/double quotes and backslash escapes.
 */
function splitCommand(command: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let hasContent = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      hasContent = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      hasContent = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        result.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) {
    result.push(current);
  }
  return result;
}

function isMamaExecutable(arg: string | undefined): boolean {
  if (!arg) {
    return false;
  }
  return (
    arg === 'mama' ||
    arg === 'mama-os' ||
    arg.endsWith('/mama') ||
    arg.endsWith('\\mama') ||
    arg.endsWith('/mama-os') ||
    arg.endsWith('\\mama-os')
  );
}

function isNodeExecutable(arg: string | undefined): boolean {
  if (!arg) {
    return false;
  }
  return arg === 'node' || arg.endsWith('/node') || arg.endsWith('\\node');
}

function isStandaloneCliPath(arg: string | undefined): boolean {
  if (!arg) {
    return false;
  }
  return (
    arg.endsWith('/packages/standalone/dist/cli/index.js') ||
    arg.endsWith('\\packages\\standalone\\dist\\cli\\index.js')
  );
}

/**
 * Execute stop command
 */
export async function stopCommand(): Promise<void> {
  console.log('\n🛑 MAMA Standalone Shutdown\n');

  // Stop watchdog first to prevent auto-restart during shutdown
  await stopWatchdog();
  await killAllMamaWatchdogs();

  // Check if running
  const runningInfo = await isDaemonRunning();
  if (!runningInfo) {
    // PID file missing — but a daemon process may still be holding the port.
    // Attempt port-based cleanup before giving up.
    console.log('⚠️  PID file not found. Checking for orphaned processes...');
    const cleaned = await killProcessesOnPorts([3847, 3849]);
    const orphans = await killAllMamaDaemons();
    if (cleaned || orphans) {
      console.log('✓ Orphaned MAMA processes cleaned up.\n');
      process.exit(0);
    }
    console.log('⚠️  MAMA is not running.\n');
    process.exit(1);
  }

  const { pid } = runningInfo;

  // Send SIGTERM to gracefully stop the process
  process.stdout.write('Stopping process... ');

  try {
    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM');

    // Wait for process to exit (up to 10 seconds for graceful shutdown)
    let attempts = 0;
    const maxAttempts = 100; // 100 * 100ms = 10 seconds

    while (isProcessRunning(pid) && attempts < maxAttempts) {
      await sleep(100);
      attempts++;
    }

    // If still running, warn user before force kill
    if (isProcessRunning(pid)) {
      console.log('\n⚠️  Process did not shut down gracefully.');
      console.log('Attempting force kill...');
      process.kill(pid, 'SIGKILL');
      await sleep(100);
    }

    // Clean up PID file
    await deletePid();

    console.log('✓');
    console.log(`PID ${pid} terminated\n`);
    // Best-effort cleanup: stop any lingering daemon wrapper processes
    await stopLingeringDaemonProcesses(pid);

    // Best-effort cleanup: kill any processes still holding MAMA ports
    await killProcessesOnPorts([3847, 3849]);

    // Verify ports are actually released (wait up to 3s)
    await waitForPortsReleased([3847, 3849], 3000);

    console.log('MAMA has been stopped.\n');
  } catch (error) {
    console.log('❌');

    // Check if process already exited
    if (!isProcessRunning(pid)) {
      await deletePid();
      console.log(`\nPID ${pid} has already exited.`);
      console.log('PID file cleaned up.\n');
      return;
    }

    console.error(
      `\nFailed to stop process: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error(`Please stop manually: kill ${pid}\n`);
    process.exit(1);
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop lingering daemon processes (wrapper shells or orphaned daemon instances).
 * This prevents "stop" from leaving a self-restarting daemon running.
 */
async function stopLingeringDaemonProcesses(primaryPid: number): Promise<void> {
  const processes = listProcesses();
  const targets = processes.filter((p) => {
    if (p.pid === primaryPid || p.pid === process.pid) {
      return false;
    }
    return isStandaloneDaemonCommand(p.command);
  });

  if (targets.length === 0) {
    return;
  }

  console.log(`Stopping ${targets.length} lingering daemon process(es)...`);

  for (const proc of targets) {
    try {
      process.kill(proc.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  // Wait briefly for graceful shutdown
  let attempts = 0;
  const maxAttempts = 20; // 2s
  while (attempts < maxAttempts) {
    const stillRunning = targets.some((p) => isProcessRunning(p.pid));
    if (!stillRunning) {
      break;
    }
    await sleep(100);
    attempts++;
  }

  // Force kill any survivors
  for (const proc of targets) {
    if (isProcessRunning(proc.pid)) {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Check if a port is in use
 */
function isPortInUse(port: number): boolean {
  try {
    const result = execSync(`lsof -ti :${port}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim().length > 0;
  } catch (err: unknown) {
    // lsof exits with code 1 when no process is listening (port is free)
    if (
      err instanceof Error &&
      'status' in err &&
      (err as NodeJS.ErrnoException & { status?: number }).status === 1
    ) {
      return false; // port is free
    }
    // lsof unavailable (e.g., Windows) or unexpected error
    logger.warn(`isPortInUse check failed for port ${port}: ${err}`);
    return false;
  }
}

/**
 * Kill processes occupying specified ports (cleanup for zombie MAMA processes)
 * @returns true if any processes were killed
 */
export async function killProcessesOnPorts(ports: number[]): Promise<boolean> {
  let killed = false;
  const processesByPid = new Map(listProcesses().map((proc) => [proc.pid, proc.command]));
  for (const port of ports) {
    try {
      const output = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (!output) continue;

      const pids = output
        .split('\n')
        .map((p) => parseInt(p.trim(), 10))
        .filter((p) => Number.isFinite(p) && p !== process.pid);
      let killedOnPort = 0;
      for (const pid of pids) {
        const command = processesByPid.get(pid);
        if (!command || !isMamaPortProcess(command)) {
          logger.warn(
            `Skipping unverified process on port ${port} (PID ${pid}) during MAMA cleanup`
          );
          continue;
        }
        try {
          process.kill(pid, 'SIGTERM');
          killed = true;
          killedOnPort++;
        } catch {
          /* already dead */
        }
      }

      if (pids.length > 0) {
        await sleep(1000);
        for (const pid of pids) {
          const command = processesByPid.get(pid);
          if (!command || !isMamaPortProcess(command)) {
            continue;
          }
          if (isProcessRunning(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }
        if (killedOnPort > 0) {
          console.log(`✓ Cleaned up ${killedOnPort} verified MAMA process(es) on port ${port}`);
        }
      }
    } catch {
      /* lsof not available or no processes */
    }
  }
  return killed;
}

function isMamaPortProcess(command: string): boolean {
  return isStandaloneDaemonCommand(command) || isStandaloneWatchdogCommand(command);
}

/**
 * Kill orphaned `mama daemon` processes that have no PID file tracking them.
 * @returns true if any processes were killed
 */
export async function killAllMamaDaemons(): Promise<boolean> {
  const processes = listProcesses();
  const targets = processes.filter((p) => {
    if (p.pid === process.pid) return false;
    return isStandaloneDaemonCommand(p.command);
  });

  if (targets.length === 0) return false;

  console.log(`Found ${targets.length} orphaned daemon process(es)...`);

  for (const proc of targets) {
    try {
      process.kill(proc.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  await sleep(2000);

  for (const proc of targets) {
    if (isProcessRunning(proc.pid)) {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  return true;
}

/**
 * Wait until all specified ports are released
 */
async function waitForPortsReleased(ports: number[], maxWaitMs: number = 3000): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 200;

  while (Date.now() - startTime < maxWaitMs) {
    const stillInUse = ports.filter((port) => isPortInUse(port));

    if (stillInUse.length === 0) {
      return;
    }
    await sleep(pollInterval);
  }

  // Timeout occurred - warn user
  const stillInUse = ports.filter((port) => isPortInUse(port));

  if (stillInUse.length > 0) {
    console.warn(
      `⚠️  Warning: Port(s) ${stillInUse.join(', ')} still in use after ${maxWaitMs}ms timeout`
    );
  }
}

/**
 * Stop the watchdog process to prevent auto-restart during shutdown
 */
async function stopWatchdog(): Promise<void> {
  const watchdogPidPath = `${homedir()}/.mama/watchdog.pid`;
  if (!existsSync(watchdogPidPath)) return;

  try {
    const content = readFileSync(watchdogPidPath, 'utf-8');
    const { pid } = JSON.parse(content);
    if (typeof pid === 'number' && isProcessRunning(pid)) {
      const command = listProcesses().find((proc) => proc.pid === pid)?.command;
      if (!command || !isStandaloneWatchdogCommand(command)) {
        logger.warn(`Skipping unverified watchdog PID ${pid}; removing stale watchdog pid file`);
      } else {
        process.kill(pid, 'SIGTERM');
        await sleep(500);
        if (isProcessRunning(pid)) {
          process.kill(pid, 'SIGKILL');
        }
        console.log(`✓ Watchdog stopped (PID ${pid})`);
      }
    }
  } catch {
    // ignore
  }

  try {
    unlinkSync(watchdogPidPath);
  } catch {
    /* ignore */
  }
}

export async function killAllMamaWatchdogs(): Promise<boolean> {
  const processes = listProcesses();
  const targets = processes.filter((p) => {
    if (p.pid === process.pid) return false;
    return isStandaloneWatchdogCommand(p.command);
  });

  if (targets.length === 0) return false;

  console.log(`Stopping ${targets.length} lingering watchdog process(es)...`);

  for (const proc of targets) {
    try {
      process.kill(proc.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  await sleep(1000);

  for (const proc of targets) {
    if (isProcessRunning(proc.pid)) {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  return true;
}

const PROCESS_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function listProcesses(): Array<{ pid: number; command: string }> {
  try {
    // -ww disables ps's command-column truncation. maxBuffer only governs how much
    // Node reads from stdout, not how much ps writes — without -ww long argv lists
    // (e.g., inlined `node -e <long script>`) get cut and break daemon detection.
    const output = execSync('ps -ww -eo pid=,command=', {
      encoding: 'utf-8',
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) {
          return null;
        }
        const pidStr = line.slice(0, spaceIdx).trim();
        const command = line.slice(spaceIdx + 1);
        const pid = parseInt(pidStr, 10);
        if (!Number.isFinite(pid)) {
          return null;
        }
        return { pid, command };
      })
      .filter((p): p is { pid: number; command: string } => p !== null);
  } catch (err) {
    logger.warn(
      `Failed to list processes; continuing best-effort cleanup: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}
