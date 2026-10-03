import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';

import {
  startEgressProxy,
  type EgressAttempt,
  type EgressProxy,
} from '../../src/runtime/egress-proxy.js';

let proxy: EgressProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

/** Writes the bytes, collects the reply until the proxy closes the connection. */
function exchange(port: number, chunks: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    socket.on('data', (data) => received.push(data));
    socket.on('close', () => resolve(Buffer.concat(received)));
    socket.on('error', reject);
  });
}

describe('egress proxy', () => {
  it('refuses an HTTPS tunnel and reports where it was going', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    const reply = await exchange(proxy.httpProxyPort, [
      Buffer.from('CONNECT upload.example:443 HTTP/1.1\r\nHost: upload.example:443\r\n\r\n'),
    ]);
    expect(reply.toString()).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(attempts).toEqual([
      { protocol: 'http', method: 'CONNECT', target: 'upload.example:443' },
    ]);
  });

  it('refuses a plain request sent in pieces and reports its method without the path', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    const reply = await exchange(proxy.httpProxyPort, [
      Buffer.from('POST http://upload.example/secret?data=x HTTP/1.1\r\n'),
      Buffer.from('Host: upload.example\r\nContent-Length: 4\r\n\r\nnull'),
    ]);
    expect(reply.toString()).toMatch(/^HTTP\/1\.1 403/);
    expect(attempts).toEqual([{ protocol: 'http', method: 'POST', target: 'upload.example:80' }]);
  });

  it('refuses a SOCKS5 connection by rule and reports its destination', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    const host = Buffer.from('upload.example');
    const reply = await exchange(proxy.socksProxyPort, [
      Buffer.from([5, 1, 0]),
      Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0x01, 0xbb])]),
    ]);
    expect([...reply]).toEqual([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(attempts).toEqual([
      { protocol: 'socks', method: 'CONNECT', target: 'upload.example:443' },
    ]);
  });

  it('reports a SOCKS5 connection to an IPv4 address', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    await exchange(proxy.socksProxyPort, [
      Buffer.from([5, 1, 0, 5, 1, 0, 1, 1, 1, 1, 1, 0x01, 0xbb]),
    ]);
    expect(attempts).toEqual([{ protocol: 'socks', method: 'CONNECT', target: '1.1.1.1:443' }]);
  });
});
