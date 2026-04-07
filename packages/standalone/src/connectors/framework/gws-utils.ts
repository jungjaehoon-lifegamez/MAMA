import { execSync } from 'child_process';

export function parseGwsOutput(raw: string): unknown {
  const lines = raw.split('\n');
  const jsonStart = lines.findIndex(
    (line) => line.trimStart().startsWith('{') || line.trimStart().startsWith('[')
  );
  if (jsonStart === -1) {
    throw new Error('No JSON found in gws CLI output');
  }
  return JSON.parse(lines.slice(jsonStart).join('\n'));
}

/**
 * Execute a gws CLI command and parse the JSON output.
 * Note: args are constructed internally by connectors using JSON.stringify
 * for parameter values — no user-supplied input is interpolated directly.
 */
export function execGws(args: string, options?: { maxBuffer?: number }): unknown {
  const raw = execSync(`gws ${args}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: options?.maxBuffer,
    timeout: 60_000,
  });
  return parseGwsOutput(raw);
}
