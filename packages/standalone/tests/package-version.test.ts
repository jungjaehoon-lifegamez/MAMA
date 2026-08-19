import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageVersionModule {
  resolvePackageVersion?: () => string;
}

describe('executing package version resolver', () => {
  it('returns the version declared by the executing standalone package', async () => {
    const versionModule = (await import('../src/package-version.js').catch(
      () => ({})
    )) as PackageVersionModule;
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };

    expect(versionModule.resolvePackageVersion?.()).toBe(packageJson.version);
  });
});
