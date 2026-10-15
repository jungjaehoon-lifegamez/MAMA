import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallBusyError } from '../../src/cli/runtime/daemon-control.js';

const failure = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../src/cli/commands/daemon.js', () => ({
  runDaemon: async () => {
    throw failure.value;
  },
}));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('mama daemon exit codes, which both service files rely on', () => {
  it('names the holder and exits cleanly when another process holds the install', async () => {
    failure.value = new InstallBusyError(
      { pid: 4242, command: 'daemon', startedAt: 0, nonce: 'fixture' },
      '/fixture/runtime/daemon.lock'
    );
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

  it('exits 1 on any other failure, so the service restarts it', async () => {
    vi.resetModules();
    failure.value = new AggregateError([new Error('fixture')], 'Daemon shutdown failed');
    process.exitCode = undefined;
    process.argv = [process.execPath, 'mama', 'daemon'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../../src/cli/index.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
  });
});
