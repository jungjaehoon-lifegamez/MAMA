import { afterEach, describe, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../src/cli/commands/control.js', () => ({
  runStatus: async () => {
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

describe('CLI failure diagnostics', () => {
  it('prints unexpected error name and code without potentially sensitive messages', async () => {
    failure.value = Object.assign(new TypeError('synthetic private detail'), { code: 'EACCES' });
    process.argv = [process.execPath, 'mama', 'status'];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../../src/cli/index.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error).toHaveBeenCalledWith('mama command failed (TypeError, EACCES)');
  });
});
