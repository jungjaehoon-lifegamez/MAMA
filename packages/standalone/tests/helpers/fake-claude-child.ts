import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

export type FakeClaudeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  pid: number;
  kill: Mock<(signal?: NodeJS.Signals | number) => boolean>;
};

export function createFakeClaudeChild(result = 'ok'): FakeClaudeChild {
  const child = new EventEmitter() as FakeClaudeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.pid = 12_345;
  child.kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    if (!child.killed) {
      child.killed = true;
      queueMicrotask(() => {
        child.emit('exit', 0);
        child.emit('close', 0);
      });
    }
    return true;
  });
  child.stdin.on('data', () => {
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result,
          session_id: 'fake-claude-session',
          usage: { input_tokens: 1, output_tokens: 1 },
        })}\n`
      );
    });
  });
  return child;
}
