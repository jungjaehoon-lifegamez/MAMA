import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { callCodeActAPI } from '../../src/mcp/code-act-api-client.js';
import {
  CodeActPostSendTransportError,
  SerializedCodeActGate,
} from '../../src/mcp/code-act-terminal-transport.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe('Code-Act API client settlement boundary', () => {
  it('marks a connection close after the request body as outcome-unknown transport state', async () => {
    let receivedBodies = 0;
    const server = createServer((request) => {
      request.resume();
      request.on('end', () => {
        receivedBodies++;
        request.socket.destroy();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const failure = await callCodeActAPI({ code: 'mutate()' }, { port, timeoutMs: 1_000 }).catch(
      (error: unknown) => error
    );

    expect(receivedBodies).toBe(1);
    expect(failure).toBeInstanceOf(CodeActPostSendTransportError);
  });

  it('latches a JSON HTTP 500 before a queued mutation can reach the API', async () => {
    let receivedBodies = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        receivedBodies++;
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ error: true, message: 'persistence failed after execution' })
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const gate = new SerializedCodeActGate();
    const invoke = () => callCodeActAPI({ code: 'mutate()' }, { port, timeoutMs: 1_000 });

    const [first, second] = await Promise.all([gate.run(invoke), gate.run(invoke)]);

    expect(receivedBodies).toBe(1);
    expect(first.terminal).toMatchObject({
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
    });
    expect(second.terminal).toEqual(first.terminal);
  });

  it('keeps a known pre-execution HTTP 4xx as a normal structured failure', async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: true, message: 'invalid request' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    await expect(callCodeActAPI({ code: '' }, { port, timeoutMs: 1_000 })).resolves.toMatchObject({
      success: false,
      error: 'invalid request',
    });
  });

  it('treats a malformed HTTP 200 result shape as outcome unknown', async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: true, message: 'missing success field' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const failure = await callCodeActAPI({ code: 'mutate()' }, { port, timeoutMs: 1_000 }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(CodeActPostSendTransportError);
  });
});
