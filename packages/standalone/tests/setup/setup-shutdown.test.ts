import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';

import type { IModelRunner } from '../../src/agent/model-runner.js';
import { createSetupWebSocketHandler } from '../../src/setup/setup-websocket.js';
import { createSetupNonceStore } from '../../src/setup/setup-server.js';
import { waitForExit } from '../../src/cli/commands/setup.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TG-03/TG-04: setup shutdown ownership', () => {
  it('keeps a valid page nonce after wrong guesses and expires it by TTL', () => {
    let now = 1_000;
    const store = createSetupNonceStore(() => now);
    const nonce = store.issue();
    expect(nonce).toBeTypeOf('string');
    expect(store.consume('wrong-nonce')).toBe(false);
    expect(store.consume(nonce!)).toBe(true);
    expect(store.consume(nonce!)).toBe(false);

    const expiring = store.issue();
    now += 10 * 60_000 + 1;
    expect(store.consume(expiring!)).toBe(false);
  });

  it('TG-03 rejects cross-origin, missing-security, and replayed setup connections', async () => {
    const wss = new EventEmitter() as WebSocketServer;
    const createRunner = vi.fn(
      () => ({ backendType: 'claude', stop: vi.fn() }) as unknown as IModelRunner
    );
    const consumeNonce = vi.fn((nonce: string) => nonce === 'once');
    const lifecycle = createSetupWebSocketHandler(wss, createRunner, undefined, {
      allowedOrigins: ['http://127.0.0.1:3848'],
      consumeNonce,
    });
    const makeSocket = () => {
      const socket = new EventEmitter() as WebSocket & {
        close: ReturnType<typeof vi.fn>;
        terminate: ReturnType<typeof vi.fn>;
      };
      socket.send = vi.fn();
      socket.close = vi.fn();
      socket.terminate = vi.fn();
      return socket;
    };
    const evil = makeSocket();
    wss.emit('connection', evil, {
      url: '/setup-ws?nonce=once',
      headers: { origin: 'https://evil.example' },
    } as IncomingMessage);
    expect(evil.close).toHaveBeenCalledWith(1008, 'Unauthorized setup connection');
    expect(createRunner).not.toHaveBeenCalled();

    const valid = makeSocket();
    wss.emit('connection', valid, {
      url: '/setup-ws?nonce=once',
      headers: { origin: 'http://127.0.0.1:3848' },
    } as IncomingMessage);
    await Promise.resolve();
    expect(createRunner).toHaveBeenCalledTimes(1);

    const replay = makeSocket();
    wss.emit('connection', replay, {
      url: '/setup-ws?nonce=once',
      headers: { origin: 'http://127.0.0.1:3848' },
    } as IncomingMessage);
    expect(replay.close).toHaveBeenCalledWith(1008, 'Unauthorized setup connection');
    expect(createRunner).toHaveBeenCalledTimes(1);
    await lifecycle.close();
  });

  it('terminates an open client and awaits its model runner before completing', async () => {
    const wss = new EventEmitter() as WebSocketServer;
    const ws = new EventEmitter() as WebSocket & { terminate: ReturnType<typeof vi.fn> };
    ws.send = vi.fn();
    ws.close = vi.fn();
    ws.terminate = vi.fn();
    const stopped = deferred();
    const runner = {
      backendType: 'cline',
      stop: vi.fn(() => stopped.promise),
    } as unknown as IModelRunner;
    const lifecycle = createSetupWebSocketHandler(
      wss,
      vi.fn(() => runner),
      undefined,
      { allowedOrigins: ['http://127.0.0.1:3848'], consumeNonce: (nonce) => nonce === 'test' }
    );

    wss.emit('connection', ws, {
      url: '/setup-ws?nonce=test',
      headers: { origin: 'http://127.0.0.1:3848' },
    } as IncomingMessage);
    await Promise.resolve();
    const closing = lifecycle.close();
    await vi.waitFor(() => expect(runner.stop).toHaveBeenCalledTimes(1));
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    stopped.resolve();
    await closing;
    expect(finished).toBe(true);
  });

  it('waits for async server close and sets exitCode without forcing process.exit', async () => {
    const closed = deferred();
    const close = vi.fn(() => closed.promise);
    const originalExitCode = process.exitCode;
    const exit = vi.spyOn(process, 'exit');
    const waiting = waitForExit({ close });
    process.emit('SIGINT');
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    closed.resolve();
    await waiting;
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    process.exitCode = originalExitCode;
    exit.mockRestore();
  });
});
