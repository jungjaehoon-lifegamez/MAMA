import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';
import { NativeTurnStoppedError } from '../../src/runtime/drivers/types.js';

class FakeChild extends EventEmitter {
  signals: string[] = [];
  lines: string[] = [];
  stdin = {
    writable: true,
    write: (line: string, done?: (err?: Error) => void) => {
      this.lines.push(line);
      done?.();
      return true;
    },
  };
  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
}

function readyProcess() {
  const child = new FakeChild();
  const proc = new PersistentClaudeProcess({
    sessionId: 'fixture-session',
    workspaceDir: '/tmp/fixture-workspace',
    requestTimeout: 60_000,
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
  return { proc, child, emit };
}

describe('persistent CLI interrupt', () => {
  it('stops the running request with the CLI interrupt and keeps the process', async () => {
    const { proc, child, emit } = readyProcess();
    expect(proc.interrupt()).toBe(false);
    const pending = proc.sendMessage('fixture');
    expect(proc.interrupt()).toBe(true);
    const control = JSON.parse(child.lines.at(-1)!) as {
      type: string;
      request: { subtype: string };
    };
    expect(control).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    emit({ type: 'control_response', response: { subtype: 'success' } });
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const error = await pending.then(
      () => null,
      (rejected: unknown) => rejected
    );
    expect(error).toBeInstanceOf(NativeTurnStoppedError);
    // The stopped turn's tokens still count.
    expect(error).toMatchObject({ usage: { input_tokens: 5, output_tokens: 2 } });
    expect(child.signals).toEqual([]);
    expect(proc.isAlive()).toBe(true);
    expect(proc.interrupt()).toBe(false);
  });

  it('lets a turn that finished before the interrupt land answer normally', async () => {
    const { proc, emit } = readyProcess();
    const pending = proc.sendMessage('fixture');
    expect(proc.interrupt()).toBe(true);
    emit({ type: 'result', subtype: 'success', result: 'done anyway', usage: {} });
    await expect(pending).resolves.toMatchObject({ response: 'done anyway' });
    // The mark ends with that request: the next request's failure is an ordinary one.
    const next = proc.sendMessage('fixture again');
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
    await expect(next).rejects.not.toBeInstanceOf(NativeTurnStoppedError);
  });

  it('keeps an unrequested failed turn an ordinary error', async () => {
    const { proc, emit } = readyProcess();
    const pending = proc.sendMessage('fixture');
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
    const error = await pending.then(
      () => null,
      (rejected: unknown) => rejected
    );
    expect(error).not.toBeInstanceOf(NativeTurnStoppedError);
    expect((error as Error).message).toBe('Claude CLI ended the turn: error_during_execution');
  });
});
