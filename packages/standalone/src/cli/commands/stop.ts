/**
 * mama stop command
 *
 * Stop MAMA agent daemon
 */

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
