import { afterEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());
const isProcessRunningMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('../../src/cli/utils/pid-manager.js', () => ({
  deletePid: vi.fn(),
  isDaemonRunning: vi.fn(),
  isProcessRunning: isProcessRunningMock,
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: vi.fn().mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('standalone stop process listing', () => {
  afterEach(() => {
    execSyncMock.mockReset();
    isProcessRunningMock.mockReset();
    vi.restoreAllMocks();
  });

  it('uses a large buffer so long Claude prompts do not break mama stop', async () => {
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
      'ps -eo pid=,command=',
      expect.objectContaining({
        encoding: 'utf-8',
        maxBuffer: expect.any(Number),
      })
    );
    const options = execSyncMock.mock.calls[0][1] as { maxBuffer: number };
    expect(options.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it('returns an empty list instead of throwing when ps output cannot be read', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('spawnSync /bin/sh ENOBUFS');
    });

    const { listProcesses } = await import('../../src/cli/commands/stop.js');

    expect(listProcesses()).toEqual([]);
  });

  it('only kills verified MAMA-owned port listeners during orphan cleanup', async () => {
    execSyncMock.mockImplementation((command: string) => {
      if (command === 'ps -eo pid=,command=') {
        return [
          '123 /usr/bin/python -m http.server 3847',
          '456 /usr/bin/node /path/to/project/packages/standalone/dist/cli/index.js daemon',
        ].join('\n');
      }
      if (command.startsWith('lsof -ti :3847')) {
        return '123\n456\n';
      }
      return '';
    });
    isProcessRunningMock.mockReturnValue(false);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const { killProcessesOnPorts } = await import('../../src/cli/commands/stop.js');

    await expect(killProcessesOnPorts([3847])).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(456, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(123, 'SIGTERM');
  });
});
