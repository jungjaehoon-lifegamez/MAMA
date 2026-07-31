import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { PersistentClaudeProcess } from '../../src/agent/persistent-cli-process.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.pid = 12345;
  child.kill = vi.fn();
  return child;
}

describe('Story S3/TG-03: persistent process context-key environment', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
  });

  it('does not let an explicit legacy env inject a process context key', async () => {
    const process = new PersistentClaudeProcess({
      sessionId: 'legacy-env-key',
      env: { MAMA_CODE_ACT_CONTEXT_KEY: 'Z'.repeat(43) },
    });

    await process.start();

    expect(spawnMock.mock.calls[0]?.[2]?.env).not.toHaveProperty('MAMA_CODE_ACT_CONTEXT_KEY');
  });

  it('replaces an explicit env key with the generated process-generation key', async () => {
    const process = new PersistentClaudeProcess({
      sessionId: 'bound-env-key',
      bindRunContext: true,
      env: { MAMA_CODE_ACT_CONTEXT_KEY: 'Z'.repeat(43) },
    });

    await process.start();

    expect(process.getRunContextKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(spawnMock.mock.calls[0]?.[2]?.env?.MAMA_CODE_ACT_CONTEXT_KEY).toBe(
      process.getRunContextKey()
    );
    expect(spawnMock.mock.calls[0]?.[2]?.env?.MAMA_CODE_ACT_CONTEXT_KEY).not.toBe('Z'.repeat(43));
  });
});
