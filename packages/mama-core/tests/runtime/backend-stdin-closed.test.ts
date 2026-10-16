/**
 * A backend that goes away while the driver writes to it fails that request; it must not end the
 * host. Writing to a pipe whose reader has closed raises EPIPE on the child's stdin, and a stream
 * error with no listener is an uncaught exception that stops the whole process.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerProcess } from '../../src/runtime/drivers/codex-app-server-process.js';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A backend that closes its stdin at once and exits a moment later. */
function closedStdinBackend(): { root: string; command: string } {
  const root = mkdtempSync(join(tmpdir(), 'mama-backend-stdin-'));
  roots.push(root);
  const command = join(root, 'backend');
  writeFileSync(command, '#!/bin/sh\nexec 0<&-\nsleep 2\nexit 1\n');
  chmodSync(command, 0o755);
  return { root, command };
}

describe('a backend whose stdin is closed', () => {
  it('fails the Codex request instead of the host', async () => {
    const { root, command } = closedStdinBackend();
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
    } finally {
      await driver.stop();
    }
  });

  it('fails the Claude request instead of the host', async () => {
    const { root, command } = closedStdinBackend();
    const driver = new PersistentClaudeProcess({
      sessionId: 'fixture-session',
      workspaceDir: root,
      command,
      requestTimeout: 10_000,
    });
    driver.on('error', () => {});
    try {
      await expect(driver.sendMessage('hello')).rejects.toThrow();
    } finally {
      driver.stop();
    }
  });
});
