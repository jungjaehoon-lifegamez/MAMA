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
  console.log('\n🛑 MAMA Standalone 종료\n');

  // Check if running
  const runningInfo = await isDaemonRunning();
  if (!runningInfo) {
    console.log('⚠️  MAMA가 실행 중이 아닙니다.\n');
    process.exit(1);
  }

  const { pid } = runningInfo;

  // Send SIGTERM to gracefully stop the process
  process.stdout.write('프로세스 종료 중... ');

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
      console.log('\n⚠️  프로세스가 정상적으로 종료되지 않았습니다.');
      console.log('강제 종료를 시도합니다...');
      process.kill(pid, 'SIGKILL');
      await sleep(100);
    }

    // Clean up PID file
    await deletePid();

    console.log('✓');
    console.log(`PID ${pid} 종료됨\n`);
    console.log('MAMA가 종료되었습니다.\n');
  } catch (error) {
    console.log('❌');

    // Check if process already exited
    if (!isProcessRunning(pid)) {
      await deletePid();
      console.log(`\nPID ${pid}가 이미 종료되어 있습니다.`);
      console.log('PID 파일을 정리했습니다.\n');
      return;
    }

    console.error(
      `\n프로세스 종료 실패: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error(`수동으로 종료하세요: kill ${pid}\n`);
    process.exit(1);
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
