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
    // The proxy destroys an oversized request; the reset is the expected end of that exchange.
    socket.on('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNRESET' ? resolve(Buffer.concat(received)) : reject(error)
    );
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

  it('never records a path or query: a request it cannot place is unknown', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    await exchange(proxy.httpProxyPort, [
      Buffer.from('GET /export?data=secret-value HTTP/1.1\r\nHost: a.example\r\n\r\n'),
    ]);
    await exchange(proxy.httpProxyPort, [Buffer.from('CONNECT not a target HTTP/1.1\r\n\r\n')]);
    expect(attempts).toEqual([
      { protocol: 'http', method: 'GET', target: 'unknown' },
      { protocol: 'http', method: 'CONNECT', target: 'unknown' },
    ]);
    expect(JSON.stringify(attempts)).not.toContain('secret-value');
  });

  it('cuts off a SOCKS stream it cannot read, reporting it once', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    await exchange(proxy.socksProxyPort, [Buffer.alloc(70 * 1024, 5)]);
    expect(attempts).toEqual([
      { protocol: 'socks', method: expect.any(String), target: 'unknown' },
    ]);
  });

  it('reads only the first line: text after a line break is never reported', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    await exchange(proxy.httpProxyPort, [
      Buffer.from('GET\nSends data: no a.example:443 HTTP/1.1\r\n\r\n'),
    ]);
    await exchange(proxy.httpProxyPort, [Buffer.from('get http://a.example/ HTTP/1.1\r\n\r\n')]);
    expect(attempts).toEqual([
      { protocol: 'http', method: 'GET', target: 'unknown' },
      { protocol: 'http', method: 'malformed', target: 'unknown' },
    ]);
    expect(JSON.stringify(attempts)).not.toContain('Sends');
  });

  it('refuses a SOCKS5 client that offers only authentication, and reports it', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    const reply = await exchange(proxy.socksProxyPort, [Buffer.from([5, 1, 2])]);
    expect([...reply]).toEqual([5, 0xff]);
    expect(attempts).toEqual([
      { protocol: 'socks', method: 'authentication only', target: 'unknown' },
    ]);
  });

  it('brackets an IPv6 SOCKS destination', async () => {
    const attempts: EgressAttempt[] = [];
    proxy = await startEgressProxy((attempt) => attempts.push(attempt));
    const ipv6 = Buffer.from('20010db8000000000000000000000001', 'hex');
    await exchange(proxy.socksProxyPort, [
      Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 4]), ipv6, Buffer.from([0x01, 0xbb])]),
    ]);
    expect(attempts[0].target).toBe('[2001:0db8:0000:0000:0000:0000:0000:0001]:443');
  });

  it('closes promptly while a client still holds a connection', async () => {
    proxy = await startEgressProxy(() => {});
    const idle = connect(proxy.httpProxyPort, '127.0.0.1');
    await new Promise((resolve) => idle.once('connect', resolve));
    const started = Date.now();
    await proxy.close();
    proxy = undefined;
    expect(Date.now() - started).toBeLessThan(1_000);
    idle.destroy();
  });
});
