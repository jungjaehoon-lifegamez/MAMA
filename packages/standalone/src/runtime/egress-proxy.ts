/**
 * The owner's shell sandbox reaches the network only through this proxy (W35.4; owner,
 * 2026-10-03). It refuses every connection and reports each attempt, so a script or any client
 * that honours the sandbox's proxy settings is seen by where it tried to go, whatever its language.
 * Shell egress stays closed as before; the proxy adds the record. A client that opens a socket
 * directly is refused by the operating system sandbox instead and is not seen here.
 */
import { createServer, type Server, type Socket } from 'node:net';

export interface EgressAttempt {
  protocol: 'http' | 'socks';
  /** CONNECT for a tunnel (HTTPS), or the HTTP method of a plain request. */
  method: string;
  /** host:port; a plain request's path is left out. */
  target: string;
}

export interface EgressProxy {
  httpProxyPort: number;
  socksProxyPort: number;
  close(): Promise<void>;
}

const REQUEST_LIMIT = 64 * 1024;
const IDLE_MS = 10_000;

function guard(socket: Socket): void {
  socket.setTimeout(IDLE_MS, () => socket.destroy());
  // A client that drops its connection ends its own attempt; nothing to report.
  socket.on('error', () => socket.destroy());
}

function httpTarget(method: string, target: string): string {
  if (method === 'CONNECT') return target;
  try {
    const url = new URL(target);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return target.slice(0, 200);
  }
}

function handleHttp(socket: Socket, report: (attempt: EgressAttempt) => void): void {
  guard(socket);
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1 && buffered.length < REQUEST_LIMIT) return;
    socket.removeAllListeners('data');
    const [method = '', target = ''] = buffered
      .subarray(0, headerEnd === -1 ? REQUEST_LIMIT : headerEnd)
      .toString('latin1')
      .split('\r\n', 1)[0]
      .split(' ');
    report({ protocol: 'http', method, target: httpTarget(method, target) });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
}

/** SOCKS5: accept the greeting without authentication, read the request, refuse it by rule. */
function handleSocks(socket: Socket, report: (attempt: EgressAttempt) => void): void {
  guard(socket);
  let buffered = Buffer.alloc(0);
  let greeted = false;
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!greeted) {
      if (buffered.length < 2) return;
      if (buffered[0] !== 5) {
        report({ protocol: 'socks', method: `version ${buffered[0]}`, target: 'unknown' });
        socket.destroy();
        return;
      }
      const length = 2 + buffered[1];
      if (buffered.length < length) return;
      buffered = buffered.subarray(length);
      greeted = true;
      socket.write(Buffer.from([5, 0]));
    }
    if (buffered.length < 5) return;
    const addressType = buffered[3];
    const addressLength =
      addressType === 1 ? 4 : addressType === 4 ? 16 : addressType === 3 ? 1 + buffered[4] : -1;
    if (addressLength < 0) {
      report({ protocol: 'socks', method: 'unknown', target: 'unknown' });
      socket.destroy();
      return;
    }
    if (buffered.length < 4 + addressLength + 2) return;
    socket.removeAllListeners('data');
    const address = buffered.subarray(4, 4 + addressLength);
    const host =
      addressType === 1
        ? [...address].join('.')
        : addressType === 3
          ? address.subarray(1).toString('latin1')
          : (address.toString('hex').match(/.{4}/g) ?? []).join(':');
    const port = buffered.readUInt16BE(4 + addressLength);
    const command = buffered[1] === 1 ? 'CONNECT' : buffered[1] === 2 ? 'BIND' : 'UDP ASSOCIATE';
    report({ protocol: 'socks', method: command, target: `${host}:${port}` });
    // Reply 0x02: connection not allowed by ruleset.
    socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Egress proxy did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Starts both proxies on loopback ports the operating system chooses. */
export async function startEgressProxy(
  report: (attempt: EgressAttempt) => void
): Promise<EgressProxy> {
  const http = createServer((socket) => handleHttp(socket, report));
  const socks = createServer((socket) => handleSocks(socket, report));
  const [httpProxyPort, socksProxyPort] = await Promise.all([listen(http), listen(socks)]);
  const closeServer = (server: Server) =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    httpProxyPort,
    socksProxyPort,
    close: async () => {
      await Promise.all([closeServer(http), closeServer(socks)]);
    },
  };
}
