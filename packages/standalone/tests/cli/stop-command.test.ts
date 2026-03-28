import { describe, expect, it } from 'vitest';

import {
  isStandaloneDaemonCommand,
  isStandaloneWatchdogCommand,
} from '../../src/cli/commands/stop.js';

const PROJECT_STANDALONE_CLI = '/path/to/project/packages/standalone/dist/cli/index.js';

describe('Story: standalone stop command detection', () => {
  describe('AC #1: detect daemon commands', () => {
    it('matches direct standalone daemon node command', () => {
      expect(isStandaloneDaemonCommand(`/usr/bin/node ${PROJECT_STANDALONE_CLI} daemon`)).toBe(
        true
      );
    });

    it('matches wrapper mama daemon command', () => {
      expect(isStandaloneDaemonCommand('mama daemon')).toBe(true);
    });

    it('does not match unrelated mama-server processes', () => {
      expect(
        isStandaloneDaemonCommand(
          'node /path/to/vendor/mama-mcp-node-sqlite/node_modules/.bin/mama-server'
        )
      ).toBe(false);
    });
  });

  describe('AC #2: detect watchdog commands', () => {
    it('matches explicit watchdog marker', () => {
      expect(isStandaloneWatchdogCommand('node -e watchdog-script --mama-watchdog')).toBe(true);
    });

    it('matches legacy inline watchdog command', () => {
      expect(
        isStandaloneWatchdogCommand(
          `node -e const DAEMON_CMD = "${PROJECT_STANDALONE_CLI}"; function checkHealth() {}`
        )
      ).toBe(true);
    });

    it('does not match unrelated node -e processes', () => {
      expect(isStandaloneWatchdogCommand('node -e console.log("hello")')).toBe(false);
    });
  });
});
