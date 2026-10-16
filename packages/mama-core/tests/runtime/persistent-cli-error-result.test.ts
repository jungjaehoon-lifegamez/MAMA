import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';

class FakeChild extends EventEmitter {
  stdin = {
    writable: true,
    write: (_line: string, done?: (err?: Error) => void) => {
      done?.();
      return true;
    },
  };
  kill(): boolean {
    return true;
  }
}

function readyProcess() {
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
  internal.process = new FakeChild();
  internal.state = 'idle';
  const emit = (event: Record<string, unknown>) =>
    internal.handleStdout(Buffer.from(`${JSON.stringify(event)}\n`));
  return { proc, emit };
}

describe('persistent CLI result flagged as an error', () => {
  it('fails the request with the CLI text instead of answering with it', async () => {
    const { proc, emit } = readyProcess();
    const pending = proc.sendMessage('fixture');
    // What a signed-out CLI reports (measured on CLI 2.1.299).
    emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await expect(pending).rejects.toThrow('Not logged in · Please run /login');
    // The process stays for the next request, which answers as usual.
    const next = proc.sendMessage('fixture again');
    emit({ type: 'result', subtype: 'success', result: 'fixture answer', usage: {} });
    await expect(next).resolves.toMatchObject({ response: 'fixture answer' });
  });
});
