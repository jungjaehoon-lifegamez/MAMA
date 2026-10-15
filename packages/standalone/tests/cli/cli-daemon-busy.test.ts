import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallBusyError } from '../../src/cli/runtime/daemon-control.js';

vi.mock('../../src/cli/commands/daemon.js', () => ({
  runDaemon: async () => {
    throw new InstallBusyError(
      { pid: 4242, command: 'daemon', startedAt: 0, nonce: 'fixture' },
      '/fixture/runtime/daemon.lock'
    );
  },
}));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('mama daemon when another process holds the install', () => {
  it('names the holder and exits cleanly', async () => {
    process.exitCode = undefined;
    process.argv = [process.execPath, 'mama', 'daemon'];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../../src/cli/index.js');
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'MAMA is already running here (daemon, pid 4242; /fixture/runtime/daemon.lock); stop it first: mama stop'
      )
    );
    expect(process.exitCode).toBeUndefined();
  });
});
