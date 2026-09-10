import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the $HOME isolation installed by tests/setup.ts.
 *
 * A test run without it rewrote the live daemon's
 * ~/.mama/mama-mcp-config.json (api-routes-init.ts writes to
 * path.join(homedir(), '.mama', ...)), stripping every gateway tool from the
 * running Claude backend until the daemon was restarted. If this file fails,
 * the whole suite is writing into the real user home - stop and fix setup.ts
 * before running anything else.
 */
describe('test HOME isolation', () => {
  it('resolves os.homedir() inside the OS temp directory', () => {
    const real = realpathSync(homedir());
    expect(real.startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  it('does not resolve to the real user home', () => {
    const realHome = process.env.MAMA_TEST_REAL_HOME;
    expect(realHome, 'setup.ts must record MAMA_TEST_REAL_HOME before overriding HOME').toBeTruthy();
    expect(realpathSync(homedir())).not.toBe(realpathSync(realHome as string));
  });

  it('provides a ~/.mama directory inside the temp home', () => {
    expect(existsSync(join(homedir(), '.mama'))).toBe(true);
  });
});
