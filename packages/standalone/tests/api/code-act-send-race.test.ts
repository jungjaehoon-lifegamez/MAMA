import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

/**
 * A worker that finished after one call failed: its result is still in the pipe when the host
 * answers the other call into the closed channel. Node reports that write as an `error` event
 * unless the send has a callback.
 */
class FinishedWorker extends EventEmitter {
  connected = true;
  stderr = new EventEmitter();
  private closed = false;
  kill() {
    return true;
  }
  send(message: { type: string; id?: string; error?: string }, callback?: (error: Error) => void) {
    if (this.closed) {
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      if (callback) process.nextTick(callback, error);
      else process.nextTick(() => this.emit('error', error));
      return false;
    }
    if (message.type === 'execute') {
      setImmediate(() => {
        this.emit('message', { type: 'callTool', id: '1', name: 'fast.fail', params: {} });
        this.emit('message', { type: 'callTool', id: '2', name: 'slow.ok', params: {} });
      });
    } else if (message.type === 'toolResult' && message.id === '1') {
      // The script rejects, sends its result and exits; the host reads the result later.
      this.closed = true;
      setTimeout(() => {
        this.emit('message', {
          type: 'result',
          success: false,
          logs: [],
          carried: {},
          error: { name: 'Error', message: message.error },
        });
        this.emit('exit', 0, null);
      }, 20);
    }
    return true;
  }
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const worker = new FinishedWorker();
    setImmediate(() => worker.emit('message', { type: 'ready' }));
    return worker;
  },
}));

const { runCodeAct } = await import('../../src/api/code-act-actions.js');

describe('code_act worker sends', () => {
  it("returns the script's own failure when an answer reaches a worker that already finished", async () => {
    const result = await runCodeAct(
      'return await Promise.all([fast.fail({}), slow.ok({})]);',
      {
        functions: [{ name: 'fast.fail' }, { name: 'slow.ok' }],
        call: (name) =>
          name === 'fast.fail'
            ? Promise.reject(new Error('invalid_input: input.source is required'))
            : new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5)),
      },
      10_000
    );
    expect(result).toMatchObject({
      success: false,
      error: { name: 'Error', message: 'invalid_input: input.source is required' },
    });
  });
});
