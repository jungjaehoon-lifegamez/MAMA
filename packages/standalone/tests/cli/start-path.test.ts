/**
 * A generated start.sh keeps the package manager's tool folders on PATH, ahead of the system's:
 * the agent's shell runs the tools the owner installed (python3 with its packages, sqlite3).
 */
import { describe, expect, it } from 'vitest';
import { startPathEntries, startScript } from '../../src/cli/launch-files.js';

const SYSTEM = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

describe('the PATH a generated start.sh sets', () => {
  it('puts Node, the backend, then the tool folders that exist, then the system', () => {
    expect(
      startPathEntries({
        nodePath: '/opt/homebrew/opt/node/bin/node',
        executablePaths: ['/srv/fixture/.local/bin/claude', '/opt/homebrew/bin/gws'],
        exists: (path) => path === '/opt/homebrew/bin' || path === '/usr/local/bin',
      })
    ).toEqual([
      '/opt/homebrew/opt/node/bin',
      '/srv/fixture/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      ...SYSTEM,
    ]);
  });

  it('adds no tool folder that does not exist', () => {
    expect(
      startPathEntries({
        nodePath: '/usr/bin/node',
        executablePaths: ['/usr/bin/codex'],
        exists: () => false,
      })
    ).toEqual(SYSTEM);
  });

  it('writes it into start.sh', () => {
    const script = startScript({
      home: '/fixture/home',
      nodePath: '/fixture/node/bin/node',
      cliPath: '/fixture/cli.js',
      executablePaths: [],
      viewer: {},
      logLevel: 'info',
      exists: (path) => path === '/opt/homebrew/bin',
    });
    expect(script).toContain(
      `export PATH='/fixture/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'`
    );
  });
});
