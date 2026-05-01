import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PersistentClaudeProcess,
  PersistentProcessPool,
} from '../../src/agent/persistent-cli-process.js';

describe('PersistentProcessPool idle cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts cleanup interval when idle timeout is disabled so pending tool waits can expire', () => {
    vi.useFakeTimers();
    const cleanupSpy = vi.spyOn(PersistentProcessPool.prototype, 'cleanupIdleProcesses');
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 0,
      cleanupIntervalMs: 100,
      pendingToolUseTimeoutMs: 200,
    });

    vi.advanceTimersByTime(100);

    expect(cleanupSpy).toHaveBeenCalled();
    pool.stopAll();
  });

  it('stops and removes ready processes after the idle timeout', async () => {
    const startedAt = 1_000;
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 100,
      cleanupIntervalMs: 0,
      pendingToolUseTimeoutMs: 1_000,
    });

    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isReady').mockReturnValue(true);
    const stopSpy = vi
      .spyOn(PersistentClaudeProcess.prototype, 'stop')
      .mockImplementation(() => {});

    await pool.getProcess('system:conductor-audit');

    expect(pool.getActiveCount()).toBe(1);
    expect(pool.cleanupIdleProcesses(startedAt + 101)).toBe(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(pool.getActiveCount()).toBe(0);
  });

  it('does not stop busy processes even when they are older than the idle timeout', async () => {
    const startedAt = 1_000;
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 100,
      cleanupIntervalMs: 0,
    });

    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isReady').mockReturnValue(false);
    const stopSpy = vi
      .spyOn(PersistentClaudeProcess.prototype, 'stop')
      .mockImplementation(() => {});

    await pool.getProcess('system:conductor-audit');

    expect(pool.cleanupIdleProcesses(startedAt + 101)).toBe(0);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(pool.getActiveCount()).toBe(1);

    pool.stopAll();
  });

  it('does not stop ready processes while Claude is waiting for tool results', async () => {
    const startedAt = 1_000;
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 100,
      cleanupIntervalMs: 0,
    });

    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isReady').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'hasPendingToolUse').mockReturnValue(true);
    const stopSpy = vi
      .spyOn(PersistentClaudeProcess.prototype, 'stop')
      .mockImplementation(() => {});

    await pool.getProcess('system:conductor-audit');

    expect(pool.cleanupIdleProcesses(startedAt + 101)).toBe(0);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(pool.getActiveCount()).toBe(1);

    pool.stopAll();
  });

  it('stops ready processes with expired pending tool-result waits', async () => {
    const startedAt = 1_000;
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 100,
      cleanupIntervalMs: 0,
      pendingToolUseTimeoutMs: 200,
    });

    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isReady').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'hasPendingToolUse').mockReturnValue(true);
    const stopSpy = vi
      .spyOn(PersistentClaudeProcess.prototype, 'stop')
      .mockImplementation(() => {});

    await pool.getProcess('system:conductor-audit');

    expect(pool.cleanupIdleProcesses(startedAt + 101)).toBe(0);
    expect(pool.cleanupIdleProcesses(startedAt + 302)).toBe(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(pool.getActiveCount()).toBe(0);
  });

  it('resets pending tool-result age between tool-use cycles', async () => {
    const startedAt = 1_000;
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 100,
      cleanupIntervalMs: 0,
      pendingToolUseTimeoutMs: 200,
    });
    let pendingSince = startedAt;

    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isReady').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'hasPendingToolUse').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'getPendingToolUseStartedAt').mockImplementation(
      () => pendingSince
    );
    const stopSpy = vi
      .spyOn(PersistentClaudeProcess.prototype, 'stop')
      .mockImplementation(() => {});

    const process = await pool.getProcess('system:conductor-audit');

    process.emit('idle');
    pendingSince = startedAt + 200;
    process.emit('idle');

    expect(pool.cleanupIdleProcesses(startedAt + 350)).toBe(0);
    expect(stopSpy).not.toHaveBeenCalled();

    expect(pool.cleanupIdleProcesses(startedAt + 401)).toBe(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('marks a process as waiting for tool results after Claude requests tools', () => {
    const process = new PersistentClaudeProcess({ sessionId: 'test-session' });
    const toolUse = {
      type: 'tool_use' as const,
      id: 'tool-1',
      name: 'mama_search',
      input: { query: 'context compile' },
    };

    (
      process as unknown as {
        toolUseBlocks: (typeof toolUse)[];
        processEvent: (event: unknown) => void;
      }
    ).toolUseBlocks = [toolUse];

    (
      process as unknown as {
        processEvent: (event: unknown) => void;
      }
    ).processEvent({
      type: 'result',
      subtype: 'success',
      result: 'need tool',
      session_id: 'test-session',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    expect(process.hasPendingToolUse()).toBe(true);
  });

  it('measures idle timeout from the idle event, not initial acquisition', async () => {
    const acquiredAt = 1_000;
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 100,
      cleanupIntervalMs: 0,
    });
    let isReady = false;

    vi.spyOn(Date, 'now').mockReturnValue(acquiredAt);
    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isReady').mockImplementation(() => isReady);
    const stopSpy = vi
      .spyOn(PersistentClaudeProcess.prototype, 'stop')
      .mockImplementation(() => {});

    const process = await pool.getProcess('system:conductor-audit');

    expect(pool.cleanupIdleProcesses(acquiredAt + 101)).toBe(0);

    isReady = true;
    vi.mocked(Date.now).mockReturnValue(acquiredAt + 200);
    process.emit('idle');

    expect(pool.cleanupIdleProcesses(acquiredAt + 250)).toBe(0);
    expect(stopSpy).not.toHaveBeenCalled();

    expect(pool.cleanupIdleProcesses(acquiredAt + 301)).toBe(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores stale close events from a process that has already been replaced', async () => {
    const pool = new PersistentProcessPool({
      idleTimeoutMs: 100,
      cleanupIntervalMs: 0,
    });

    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isReady').mockReturnValue(true);
    vi.spyOn(PersistentClaudeProcess.prototype, 'stop').mockImplementation(() => {});

    const oldProcess = await pool.getProcess('system:conductor-audit');
    expect(pool.cleanupIdleProcesses(Date.now() + 101)).toBe(1);

    const replacement = await pool.getProcess('system:conductor-audit');
    expect(replacement).not.toBe(oldProcess);
    expect(pool.getActiveCount()).toBe(1);

    oldProcess.emit('close', 0);

    expect(pool.getActiveCount()).toBe(1);
  });
});

describe('PersistentClaudeProcess stop()', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('escalates to SIGKILL when the child does not exit after SIGTERM', async () => {
    vi.useFakeTimers();
    const process = new PersistentClaudeProcess({ sessionId: 'test-session' });
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = { end: vi.fn() };
    child.kill = vi.fn();

    (
      process as unknown as {
        process: typeof child;
        state: string;
      }
    ).process = child;
    (
      process as unknown as {
        state: string;
      }
    ).state = 'idle';

    process.stop();

    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(3_000);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
