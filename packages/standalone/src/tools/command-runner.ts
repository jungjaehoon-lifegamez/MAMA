import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { onToolkitSignal } from './toolkit-process.js';

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<{ stdout: string; stderr: string }>;

/** No shell interpolation. Bound output, time and descendants (LibreOffice may spawn a child). */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const kill = (error: Error) => {
      failure = error;
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error);
      }
    };
    const unregister = onToolkitSignal(() => kill(new Error('Document command interrupted')));
    const timer = setTimeout(
      () => kill(new Error(`${basename(command)} timed out`)),
      options.timeoutMs ?? 120_000
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > 1024 * 1024)
        kill(new Error(`${basename(command)} exceeded the command output limit`));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > 1024 * 1024)
        kill(new Error(`${basename(command)} exceeded the command output limit`));
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      unregister();
      reject(new Error(`${basename(command)} unavailable (${error.code ?? 'spawn failed'})`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      unregister();
      if (failure) reject(failure);
      else if (code !== 0) {
        // The last stderr line names the cause (a Python traceback ends with it).
        const cause = stderr.trim().split('\n').at(-1)?.trim().slice(0, 300);
        reject(
          new Error(
            `${basename(command)} failed (exit ${String(code)})${cause ? `: ${cause}` : ''}`
          )
        );
      } else resolve({ stdout, stderr });
    });
  });
