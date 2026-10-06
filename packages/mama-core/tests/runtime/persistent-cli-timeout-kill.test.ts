import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';

class FakeChild extends EventEmitter {
  killed = false;
  signals: string[] = [];
  stdin = { writable: true, write: (_line: string, done?: (err?: Error) => void) => done?.() };
  kill(signal: string): boolean {
    this.signals.push(signal);
    // Node marks a child killed as soon as a signal is delivered, whether or not it exits.
    this.killed = true;
    return true;
  }
}

function timedOut(child: FakeChild): void {
  const proc = new PersistentClaudeProcess({ sessionId: 'fixture-session' } as never);
  (proc as unknown as { process: FakeChild }).process = child;
  (proc as unknown as { handleTimeout(reason: string): void }).handleTimeout('fixture');
}

/** A process ready for a request, with its output fed by the test. */
function readyProcess(options: { requestTimeout: number; requestMaxMs?: number }) {
  const child = new FakeChild();
  const proc = new PersistentClaudeProcess({
    sessionId: 'fixture-session',
    workspaceDir: '/tmp/fixture-workspace',
    ...options,
  });
  const internal = proc as unknown as {
    process: FakeChild;
    state: string;
    handleStdout(chunk: Buffer): void;
  };
  internal.process = child;
  internal.state = 'idle';
  const emit = (event: Record<string, unknown>) =>
    internal.handleStdout(Buffer.from(`${JSON.stringify(event)}\n`));
  const print = () =>
    internal.handleStdout(
      Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'status' })}\n`)
    );
  return { proc, child, print, emit };
}

describe('persistent CLI request timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('reports a compact boundary observed before a request times out', async () => {
    vi.useFakeTimers();
    const { proc, emit } = readyProcess({ requestTimeout: 1_000 });
    const pending = proc.sendMessage('fixture');
    emit({ type: 'system', subtype: 'compact_boundary' });
    const rejected = expect(pending).rejects.toMatchObject({ usage: { compaction_count: 1 } });
    vi.advanceTimersByTime(1_001);
    await rejected;
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    timedOut(child);
    vi.advanceTimersByTime(3000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not SIGKILL a child that exited after SIGTERM', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    timedOut(child);
    child.emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(3000);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('keeps a request that keeps printing and stops one that goes silent', async () => {
    vi.useFakeTimers();
    const { proc, child, print } = readyProcess({ requestTimeout: 1_000 });
    const result = proc.sendMessage('long work');
    const settled = vi.fn();
    result.catch(settled);
    for (let step = 0; step < 5; step += 1) {
      vi.advanceTimersByTime(900);
      print();
    }
    await Promise.resolve();
    // 4.5 s into a request with a 1 s limit, still running: each output restarted it.
    expect(settled).not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(1_000);
    await expect(result).rejects.toThrow('Request timeout: no output for 1000 ms');
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('stops a request that keeps printing once it runs past the whole-request limit', async () => {
    vi.useFakeTimers();
    const { proc, child, print } = readyProcess({ requestTimeout: 1_000, requestMaxMs: 3_000 });
    const result = proc.sendMessage('endless work');
    const settled = vi.fn();
    result.catch(settled);
    for (let step = 0; step < 3; step += 1) {
      vi.advanceTimersByTime(900);
      print();
    }
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    await expect(result).rejects.toThrow('Request timeout: running longer than 3000 ms');
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('clears the whole-request limit when the request ends', async () => {
    vi.useFakeTimers();
    const { proc, child, emit } = readyProcess({ requestTimeout: 1_000, requestMaxMs: 3_000 });
    const result = proc.sendMessage('short work');
    emit({ type: 'result', subtype: 'success', result: 'done', usage: {} });
    await expect(result).resolves.toMatchObject({ response: 'done' });
    vi.advanceTimersByTime(10_000);
    expect(child.signals).toEqual([]);
  });

  it('ends a request on a result that is neither success nor flagged as an error', async () => {
    vi.useFakeTimers();
    const { proc, emit } = readyProcess({ requestTimeout: 1_000, requestMaxMs: 3_000 });
    const result = proc.sendMessage('work');
    emit({ type: 'result', subtype: 'error_max_turns', is_error: false });
    await expect(result).rejects.toThrow('Claude CLI ended the turn: error_max_turns');
  });
});
