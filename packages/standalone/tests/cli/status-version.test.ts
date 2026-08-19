import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import * as statusModule from '../../src/cli/commands/status.js';

interface VersionStatusModule {
  formatVersionStatus?: (cliVersion: string, runtimeVersion: string | null) => string[];
  fetchRuntimeVersion?: (options?: {
    hostname?: string;
    port?: number;
    timeoutMs?: number;
  }) => Promise<string | null>;
}

const formatVersionStatus = (statusModule as VersionStatusModule).formatVersionStatus;
const fetchRuntimeVersion = (statusModule as VersionStatusModule).fetchRuntimeVersion;

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function withRuntimeServer(
  listener: RequestListener,
  run: (port: number) => Promise<void>
): Promise<void> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await closeServer(server);
  }
}

async function resolveWithin(
  promise: Promise<string | null> | undefined,
  milliseconds: number
): Promise<string | null | 'did-not-settle'> {
  let deadline: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise ?? Promise.resolve('did-not-settle' as const),
      new Promise<'did-not-settle'>((resolve) => {
        deadline = setTimeout(() => resolve('did-not-settle'), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(deadline!);
  }
}

describe('mama status package versions', () => {
  it('prints both versions without a warning when CLI and daemon match', () => {
    expect(formatVersionStatus?.('0.36.0', '0.36.0')).toEqual([
      'CLI version: 0.36.0',
      'Runtime version: 0.36.0',
    ]);
  });

  it('warns clearly when the CLI and executing daemon differ', () => {
    expect(formatVersionStatus?.('0.36.0', '0.35.1')).toEqual([
      'CLI version: 0.36.0',
      'Runtime version: 0.35.1',
      '⚠️  Version mismatch: the running daemon and this CLI use different packages. Verify or update the daemon service entrypoint, then restart and recheck.',
    ]);
  });

  it('keeps status informative when the runtime endpoint or version is unavailable', () => {
    expect(formatVersionStatus?.('0.36.0', null)).toEqual([
      'CLI version: 0.36.0',
      'Runtime version: unavailable',
    ]);
  });

  it('fetches the executing version from the daemon runtime-status endpoint', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(request.url === '/api/runtime/status' ? '{"version":"0.35.1"}' : '{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      expect(await fetchRuntimeVersion?.({ port })).toBe('0.35.1');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('returns unavailable when the daemon endpoint cannot be reached', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );

    expect(await fetchRuntimeVersion?.({ port, timeoutMs: 100 })).toBeNull();
  });

  it('settles unavailable when a response aborts after a partial body', async () => {
    await withRuntimeServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"version":"partial');
        setImmediate(() => response.destroy());
      },
      async (port) => {
        expect(
          await resolveWithin(fetchRuntimeVersion?.({ port, timeoutMs: 1000 }), 400)
        ).toBeNull();
      }
    );
  });

  it('settles unavailable when the connection closes before the declared body completes', async () => {
    await withRuntimeServer(
      (_request, response) => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '100',
        });
        response.write('{"version":"0.35.1"}');
        setImmediate(() => response.socket?.end());
      },
      async (port) => {
        expect(
          await resolveWithin(fetchRuntimeVersion?.({ port, timeoutMs: 1000 }), 400)
        ).toBeNull();
      }
    );
  });

  it('rejects an oversized response without waiting for the server to finish', async () => {
    await withRuntimeServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write(Buffer.alloc(65_537, 97));
      },
      async (port) => {
        expect(
          await resolveWithin(fetchRuntimeVersion?.({ port, timeoutMs: 1000 }), 400)
        ).toBeNull();
      }
    );
  });

  it('uses a wall-clock deadline that trickled bytes cannot extend', async () => {
    await withRuntimeServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        const interval = setInterval(() => response.write(' '), 10);
        response.on('close', () => clearInterval(interval));
      },
      async (port) => {
        expect(await resolveWithin(fetchRuntimeVersion?.({ port, timeoutMs: 80 }), 400)).toBeNull();
      }
    );
  });
});
