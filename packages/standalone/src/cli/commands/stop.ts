/**
 * mama stop command
 *
 * Stop MAMA agent daemon
 */

import { execSync } from 'node:child_process';
import { isDaemonRunning, deletePid, isProcessRunning } from '../utils/pid-manager.js';

/**
 * Execute stop command
 */
export async function stopCommand(): Promise<void> {
  console.log('\n🛑 MAMA Standalone Shutdown\n');

  // Check if running
  const runningInfo = await isDaemonRunning();
  if (!runningInfo) {
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
    return p.command.includes('mama daemon');
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
 * Kill processes occupying specified ports (cleanup for zombie MAMA processes)
 */
export async function killProcessesOnPorts(ports: number[]): Promise<void> {
  for (const port of ports) {
    try {
      const output = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (!output) continue;

      const pids = output
        .split('\n')
        .map((p) => parseInt(p.trim(), 10))
        .filter((p) => Number.isFinite(p) && p !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
      }

      if (pids.length > 0) {
        await sleep(1000);
        for (const pid of pids) {
          if (isProcessRunning(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }
        console.log(`✓ Cleaned up ${pids.length} process(es) on port ${port}`);
      }
    } catch {
      /* lsof not available or no processes */
    }
  }
}

function listProcesses(): Array<{ pid: number; command: string }> {
  try {
    const output = execSync('ps -eo pid=,command=', { encoding: 'utf-8' });
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
    throw new Error(
      `Failed to list processes: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
