import { execFile } from 'node:child_process';

export interface GwsCallOptions {
  maxBuffer?: number;
  /** Defaults to 60 s; a download names its own. */
  timeoutMs?: number;
}

/** gws prints the API's error as JSON on stdout and exits non-zero; that error names the cause. */
function stdoutError(stdout: string, exit: Error): Error | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  let parsed: { error?: unknown };
  try {
    parsed = JSON.parse(stdout.slice(start)) as { error?: unknown };
  } catch {
    // Not the API's error JSON: the exit error is the report.
    return null;
  }
  return parsed.error === undefined
    ? null
    : new Error(`gws CLI returned an error: ${JSON.stringify(parsed.error)}`, { cause: exit });
}

async function execGwsStdoutAsync(args: string[], options?: GwsCallOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'gws',
      args,
      { encoding: 'utf8', maxBuffer: options?.maxBuffer, timeout: options?.timeoutMs ?? 60_000 },
      (error, value) => {
        if (error) {
          reject(stdoutError(value, error) ?? error);
          return;
        }
        resolve(value);
      }
    );
  });
}

export function parseGwsOutput(raw: string): unknown {
  const lines = raw.split('\n');
  const jsonStart = lines.findIndex(
    (line) => line.trimStart().startsWith('{') || line.trimStart().startsWith('[')
  );
  if (jsonStart === -1) throw new Error('No JSON found in gws CLI output');
  const result: unknown = JSON.parse(lines.slice(jsonStart).join('\n'));
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`gws CLI returned an error: ${JSON.stringify(result.error)}`);
  }
  return result;
}

/** Run non-JSON gws commands with argv and without blocking the daemon. */
export function execGwsTextAsync(args: string[]): Promise<string> {
  return execGwsStdoutAsync(args);
}

/** Keep upstream page tokens in argv, never in a shell command; do not block the daemon. */
export async function execGwsAsync(args: string[], options?: GwsCallOptions): Promise<unknown> {
  const stdout = await execGwsStdoutAsync(args, options);
  return parseGwsOutput(stdout);
}
