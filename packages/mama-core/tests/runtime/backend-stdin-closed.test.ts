/**
 * A backend that stops reading while the driver writes to it fails that request and is stopped;
 * it must not end the host. Writing to a pipe whose reader has closed raises EPIPE on the child's
 * stdin, and a stream error with no listener is an uncaught exception that stops the whole process.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerProcess } from '../../src/runtime/drivers/codex-app-server-process.js';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A backend that closes its stdin at once and would otherwise stay up for half a minute. */
function closedStdinBackend(): { root: string; command: string; stopped: () => Promise<boolean> } {
  const root = mkdtempSync(join(tmpdir(), 'mama-backend-stdin-'));
  roots.push(root);
  const command = join(root, 'backend');
  const pidFile = join(root, 'pid');
  writeFileSync(command, `#!/bin/sh\necho $$ > '${pidFile}'\nexec 0<&-\nexec sleep 30\n`);
  chmodSync(command, 0o755);
  const stopped = async (): Promise<boolean> => {
    if (!existsSync(pidFile)) return false;
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    for (let i = 0; i < 50; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  return { root, command, stopped };
}

describe('a backend whose stdin is closed', () => {
  it('fails the Codex request and stops the app-server, instead of ending the host', async () => {
    const { root, command, stopped } = closedStdinBackend();
    const driver = new CodexAppServerProcess({
      hostRootDir: root,
      cwd: root,
      sessionKey: 'fixture',
      model: 'fixture',
      systemPrompt: '',
      sandbox: 'workspace-write',
      command,
      requestTimeout: 10_000,
    });
    try {
      await expect(driver.prompt('hello')).rejects.toThrow();
      expect(await stopped()).toBe(true);
    } finally {
      await driver.stop();
    }
  });

  it('fails the Claude request and ends that process, instead of ending the host', async () => {
    const { root, command, stopped } = closedStdinBackend();
    const driver = new PersistentClaudeProcess({
      sessionId: 'fixture-session',
      workspaceDir: root,
      command,
      requestTimeout: 10_000,
    });
    driver.on('error', () => {});
    try {
      await expect(driver.sendMessage('hello')).rejects.toThrow();
      expect(driver.isAlive()).toBe(false);
      expect(await stopped()).toBe(true);
    } finally {
      driver.stop();
    }
  });
});
