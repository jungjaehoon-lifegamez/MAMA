import { describe, expect, it } from 'vitest';

import {
  isStandaloneDaemonCommand,
  isStandaloneWatchdogCommand,
} from '../../src/cli/commands/stop.js';

describe('isStandaloneDaemonCommand', () => {
  it('matches direct standalone daemon node command', () => {
    expect(
      isStandaloneDaemonCommand(
        '/opt/homebrew/Cellar/node/25.8.0/bin/node /Users/jeongjaehun/project/MAMA/packages/standalone/dist/cli/index.js daemon'
      )
    ).toBe(true);
  });

  it('matches wrapper mama daemon command', () => {
    expect(isStandaloneDaemonCommand('mama daemon')).toBe(true);
  });

  it('does not match unrelated mama-server processes', () => {
    expect(
      isStandaloneDaemonCommand(
        'node /Users/jeongjaehun/.codex/vendor/mama-mcp-node-sqlite/node_modules/.bin/mama-server'
      )
    ).toBe(false);
  });
});

describe('isStandaloneWatchdogCommand', () => {
  it('matches explicit watchdog marker', () => {
    expect(isStandaloneWatchdogCommand('node -e watchdog-script --mama-watchdog')).toBe(true);
  });

  it('matches legacy inline watchdog command', () => {
    expect(
      isStandaloneWatchdogCommand(
        'node -e const DAEMON_CMD = "/Users/jeongjaehun/project/MAMA/packages/standalone/dist/cli/index.js"; function checkHealth() {}'
      )
    ).toBe(true);
  });

  it('does not match unrelated node -e processes', () => {
    expect(isStandaloneWatchdogCommand('node -e console.log("hello")')).toBe(false);
  });
});
