/**
 * The owner's shell sandbox reaches the network only through this proxy (W35.4; owner,
 * 2026-10-03). It refuses every connection and reports each attempt, so a script or any client
 * that honours the sandbox's proxy settings is seen by where it tried to go, whatever its language.
 * Shell egress stays closed as before; the proxy adds the record. A client that opens a socket
 * directly is refused by the operating system sandbox instead and is not seen here.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { MemberConnectionEvent } from '../api/security-events.js';

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

/** Each endpoint's callback is bound to its member, independently of executing turns. */
export function startMemberEgressProxy(
  principalId: string,
  report: (event: MemberConnectionEvent) => void
): Promise<EgressProxy> {
  return startEgressProxy((attempt) =>
    report({ principalId, host: attempt.target, time: new Date().toISOString() })
  );
}

const REQUEST_LIMIT = 64 * 1024;
const IDLE_MS = 10_000;
// A destination longer than a DNS name and port is not a destination; keep reports bounded.
const TARGET_LIMIT = 270;

// A client retrying in a loop must not hold the daemon's sockets without bound.
const CONNECTION_LIMIT = 256;

const bounded = (value: string): string => value.slice(0, TARGET_LIMIT);

function guard(socket: Socket): void {
  socket.setTimeout(IDLE_MS, () => socket.destroy());
  // A client that drops its connection ends its own attempt; nothing to report.
  socket.on('error', () => socket.destroy());
}

/** The refusal is the whole answer: the connection closes once it is written. */
function refuse(socket: Socket, reply: string | Buffer): void {
  socket.removeAllListeners('data');
  socket.end(reply, () => socket.destroy());
}

/** host:port only: a plain request's path and query may carry the data being sent. */
function httpTarget(method: string, target: string): string {
  if (method === 'CONNECT') return /^[^\s/?#]+:\d{1,5}$/.test(target) ? bounded(target) : 'unknown';
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'unknown';
  }
  return bounded(`${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);
}

function handleHttp(socket: Socket, report: (attempt: EgressAttempt) => void): void {
  guard(socket);
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk.subarray(0, REQUEST_LIMIT - buffered.length)]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1 && buffered.length < REQUEST_LIMIT) return;
    socket.removeAllListeners('data');
    const [method = '', target = ''] = buffered
      .subarray(0, headerEnd === -1 ? REQUEST_LIMIT : headerEnd)
      .toString('latin1')
      .split(/\r?\n/, 1)[0]
      .split(' ');
    // A method is a short upper-case token; anything else is reported as malformed, never echoed.
    const valid = /^[A-Z]{1,16}$/.test(method);
    report({
      protocol: 'http',
      method: valid ? method : 'malformed',
      target: valid ? httpTarget(method, target) : 'unknown',
    });
    refuse(socket, 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
}

/**
 * SOCKS5: accept the greeting when it offers no authentication, read the request, refuse it by
 * rule. A client offering only other methods is refused at the greeting.
 */
function handleSocks(socket: Socket, report: (attempt: EgressAttempt) => void): void {
  guard(socket);
  let buffered = Buffer.alloc(0);
  let greeted = false;
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > REQUEST_LIMIT) {
      report({ protocol: 'socks', method: 'oversized', target: 'unknown' });
      socket.destroy();
      return;
    }
    if (!greeted) {
      if (buffered.length < 2) return;
      if (buffered[0] !== 5) {
        report({ protocol: 'socks', method: `version ${buffered[0]}`, target: 'unknown' });
        socket.destroy();
        return;
      }
      const length = 2 + buffered[1];
      if (buffered.length < length) return;
      if (!buffered.subarray(2, length).includes(0)) {
        report({ protocol: 'socks', method: 'authentication only', target: 'unknown' });
        refuse(socket, Buffer.from([5, 0xff]));
        return;
      }
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
          : `[${(address.toString('hex').match(/.{4}/g) ?? []).join(':')}]`;
    const port = buffered.readUInt16BE(4 + addressLength);
    const command = buffered[1] === 1 ? 'CONNECT' : buffered[1] === 2 ? 'BIND' : 'UDP ASSOCIATE';
    report({ protocol: 'socks', method: command, target: bounded(`${host}:${port}`) });
    // Reply 0x02: connection not allowed by ruleset.
    refuse(socket, Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
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
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const http = createServer((socket) => {
    track(socket);
    handleHttp(socket, report);
  });
  const socks = createServer((socket) => {
    track(socket);
    handleSocks(socket, report);
  });
  http.maxConnections = CONNECTION_LIMIT;
  socks.maxConnections = CONNECTION_LIMIT;
  const closeServer = (server: Server) =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  const bound = await Promise.allSettled([listen(http), listen(socks)]);
  if (bound[0].status === 'rejected' || bound[1].status === 'rejected') {
    // A half-started proxy must not keep a port open; the boot fails with the bind error.
    await Promise.all([http, socks].filter((server) => server.listening).map(closeServer));
    throw (bound[0].status === 'rejected' ? bound[0] : (bound[1] as PromiseRejectedResult)).reason;
  }
  const [httpProxyPort, socksProxyPort] = [bound[0].value, bound[1].value];
  return {
    httpProxyPort,
    socksProxyPort,
    close: async () => {
      const closing = Promise.all([closeServer(http), closeServer(socks)]);
      // A client still holding a connection must not hold up the daemon's shutdown.
      for (const socket of sockets) socket.destroy();
      await closing;
    },
  };
}
