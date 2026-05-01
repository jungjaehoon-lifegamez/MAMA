/**
 * Tests for the standalone stop-command process-listing helpers.
 *
 * Per AGENTS.md: do NOT mock internal modules. We mock `node:child_process`
 * because it is the system-call boundary the helpers wrap, but the project's
 * own `pid-manager` and `debug-logger` modules run as the real implementations.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

describe('STORY-STOP-PROCESS-LIST: standalone stop process listing', () => {
  afterEach(() => {
    execSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it('AC: uses a large buffer so long Claude prompts do not break mama stop', async () => {
    // AC: process listing preserves long command lines for daemon detection.
    execSyncMock.mockReturnValue(
      '123 /usr/bin/node /path/to/project/packages/standalone/dist/cli/index.js daemon\n'
    );

    const { listProcesses } = await import('../../src/cli/commands/stop.js');

    expect(listProcesses()).toEqual([
      {
        pid: 123,
        command: '/usr/bin/node /path/to/project/packages/standalone/dist/cli/index.js daemon',
      },
    ]);
    expect(execSyncMock).toHaveBeenCalledWith(
      'ps -ww -eo pid=,command=',
      expect.objectContaining({
        encoding: 'utf-8',
        maxBuffer: expect.any(Number),
      })
    );
    const options = execSyncMock.mock.calls[0][1] as { maxBuffer: number };
    expect(options.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it('AC: throws when process listing cannot be read', async () => {
    // AC: process listing failures propagate instead of masquerading as no processes.
    execSyncMock.mockImplementation(() => {
      throw new Error('spawnSync /bin/sh ENOBUFS');
    });

    const { listProcesses } = await import('../../src/cli/commands/stop.js');

    expect(() => listProcesses()).toThrow(/Failed to list processes/);
  });

  it('AC: only kills verified MAMA-owned port listeners during orphan cleanup', async () => {
    // AC: port cleanup never signals unverified processes.
    // Use very large PIDs that are guaranteed not to map to real processes,
    // so the real `isProcessRunning(pid)` (process.kill(pid, 0)) returns
    // ESRCH/false and the helpers do not escalate to a SIGKILL on us.
    const NON_MAMA_PID = 999_999_990;
    const MAMA_PID = 999_999_991;

    execSyncMock.mockImplementation((command: string) => {
      if (command === 'ps -ww -eo pid=,command=') {
        return [
          `${NON_MAMA_PID} /usr/bin/python -m http.server 3847`,
          `${MAMA_PID} /usr/bin/node /path/to/project/packages/standalone/dist/cli/index.js daemon`,
        ].join('\n');
      }
      if (command.startsWith('lsof -ti :3847')) {
        return `${NON_MAMA_PID}\n${MAMA_PID}\n`;
      }
      return '';
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      // signal 0 is the liveness probe used by pid-manager.isProcessRunning.
      // Returning false means "not running" so the SIGKILL escalation path
      // is not exercised, which keeps assertions focused on SIGTERM intent.
      if (signal === 0) {
        return false as unknown as true;
      }
      return true;
    });

    const { killProcessesOnPorts } = await import('../../src/cli/commands/stop.js');

    await expect(killProcessesOnPorts([3847])).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(MAMA_PID, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(NON_MAMA_PID, 'SIGTERM');
  });

  it('AC: does not verify a stale PID that has been reused by an unrelated process', async () => {
    // AC: stale PID verification fails closed for unrelated commands.
    execSyncMock.mockReturnValue('123 /usr/bin/python -m http.server 3847\n');

    const { findStandaloneDaemonCommandForPid } = await import('../../src/cli/commands/stop.js');

    expect(findStandaloneDaemonCommandForPid(123)).toBeUndefined();
  });

  it('AC: verifies a PID when live command is standalone daemon', async () => {
    // AC: live PID verification accepts only standalone daemon commands.
    execSyncMock.mockReturnValue(
      '123 /usr/bin/node /path/to/project/packages/standalone/dist/cli/index.js daemon\n'
    );

    const { findStandaloneDaemonCommandForPid } = await import('../../src/cli/commands/stop.js');

    expect(findStandaloneDaemonCommandForPid(123)).toBe(
      '/usr/bin/node /path/to/project/packages/standalone/dist/cli/index.js daemon'
    );
  });
});
