import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the version declared by the package containing the executing code. */
export function resolvePackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string' && packageJson.version.length > 0
      ? packageJson.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
