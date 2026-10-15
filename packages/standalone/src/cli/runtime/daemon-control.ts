import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CliInputError } from '../prompt.js';

/**
 * One install runs one process that owns its stores: the daemon, or a replay or backfill booted
 * the same way, or register-owner. Its claim is an exclusive SQLite lock on `runtime/daemon.lock`,
 * held for the process's life and released by the operating system when the process ends, so a
 * crash, a reboot or a reused pid never leaves a claim behind. `runtime/daemon.holder.json` names
 * the holder for `mama status`. The token for the control socket also lives under `runtime/`,
 * which the agents' native reads deny, so a session that reaches the socket still cannot use it.
 * The socket sits beside `runtime.sock` at the root, so it fits the same AF_UNIX path limit
 * (104 bytes on macOS).
 */

export interface DaemonControlPaths {
  readonly lockPath: string;
  readonly holderPath: string;
  readonly socketPath: string;
  readonly tokenPath: string;
}

export function daemonControlPaths(mamaRoot: string): DaemonControlPaths {
  const runtimeRoot = join(mamaRoot, 'runtime');
  return {
    lockPath: join(runtimeRoot, 'daemon.lock'),
    holderPath: join(runtimeRoot, 'daemon.holder.json'),
    socketPath: join(mamaRoot, 'daemon.sock'),
    tokenPath: join(runtimeRoot, 'daemon.token'),
  };
}

export interface LockOwner {
  readonly pid: number;
  readonly command: string;
  readonly startedAt: number;
  readonly nonce: string;
}

/** A CLI input error: the message names the holder and the fix, and carries no secret. */
export class InstallBusyError extends CliInputError {
  readonly code = 'MAMA_INSTALL_BUSY';
  constructor(
    readonly holder: LockOwner | null,
    lockPath: string
  ) {
    super(
      holder === null
        ? `MAMA is already running here (${lockPath}); stop it first: mama stop`
        : `MAMA is already running here (${holder.command}, pid ${holder.pid}; ${lockPath}); stop it first: mama stop`
    );
    this.name = 'InstallBusyError';
  }
}

export interface InstallLock {
  readonly owner: LockOwner;
  release(): void;
}

function readHolder(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>;
    return typeof value.pid === 'number' &&
      typeof value.command === 'string' &&
      typeof value.startedAt === 'number' &&
      typeof value.nonce === 'string'
      ? (value as LockOwner)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isBusy(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'SQLITE_BUSY';
}

/**
 * Take the install's lock: an exclusive transaction on the lock database, kept open for the
 * process's life. A held lock refuses after `busyTimeoutMs`, which only outlasts the moment a
 * `mama status` probe reads the file.
 */
export function acquireInstallLock(
  paths: DaemonControlPaths,
  command: string,
  options: { busyTimeoutMs?: number } = {}
): InstallLock {
  mkdirSync(join(paths.lockPath, '..'), { recursive: true, mode: 0o700 });
  const db = new Database(paths.lockPath, { timeout: options.busyTimeoutMs ?? 2_000 });
  try {
    chmodSync(paths.lockPath, 0o600);
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (isBusy(error)) throw new InstallBusyError(readHolder(paths.holderPath), paths.lockPath);
    throw error;
  }
  const owner: LockOwner = {
    pid: process.pid,
    command,
    startedAt: Date.now(),
    nonce: randomUUID(),
  };
  const staged = `${paths.holderPath}.${owner.nonce}`;
  writeFileSync(staged, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(staged, paths.holderPath);
  let released = false;
  return {
    owner,
    release: () => {
      if (released) return;
      released = true;
      if (readHolder(paths.holderPath)?.nonce === owner.nonce) rmSync(paths.holderPath);
      db.close();
    },
  };
}

/**
 * The process that holds the install, or null when none does. Reading the lock database needs a
 * shared lock, which the holder's exclusive one refuses; when nothing holds it, the read takes the
 * shared lock for an instant only.
 */
export function lockHolder(paths: DaemonControlPaths): LockOwner | null {
  if (!existsSync(paths.lockPath)) return null;
  const db = new Database(paths.lockPath, { readonly: true, timeout: 0 });
  try {
    db.pragma('schema_version');
    return null;
  } catch (error) {
    if (!isBusy(error)) throw error;
    return (
      readHolder(paths.holderPath) ?? { pid: 0, command: 'unknown', startedAt: 0, nonce: 'unknown' }
    );
  } finally {
    db.close();
  }
}

export type DaemonControlOp = 'status' | 'stop';

export interface DaemonControlHandlers {
  status(): Promise<Record<string, unknown>> | Record<string, unknown>;
  stop(): void;
}

export interface DaemonControlServer {
  close(): Promise<void>;
}

const MAX_REQUEST_BYTES = 4096;

/**
 * Serve status and stop to the CLI. Only the lock holder calls this, so removing a socket left by
 * a dead holder never removes a live one. Each boot writes a new token; a request without it is
 * refused.
 */
export async function startDaemonControl(
  paths: DaemonControlPaths,
  handlers: DaemonControlHandlers
): Promise<DaemonControlServer> {
  const token = randomBytes(32).toString('hex');
  rmSync(paths.tokenPath, { force: true });
  writeFileSync(paths.tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
  rmSync(paths.socketPath, { force: true });
  const expected = Buffer.from(token, 'utf8');
  const server: Server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      void answer(line).then(
        (reply) => socket.end(`${JSON.stringify(reply)}\n`),
        (error: unknown) =>
          socket.end(
            `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
          )
      );
    });
  });
  async function answer(line: string): Promise<Record<string, unknown>> {
    let request: { token?: unknown; op?: unknown };
    try {
      request = JSON.parse(line) as { token?: unknown; op?: unknown };
    } catch {
      return { ok: false, error: 'invalid request' };
    }
    const given = Buffer.from(typeof request.token === 'string' ? request.token : '', 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, error: 'unauthorized' };
    }
    if (request.op === 'status') return { ok: true, status: await handlers.status() };
    if (request.op === 'stop') {
      handlers.stop();
      return { ok: true };
    }
    return { ok: false, error: 'unknown op' };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    rmSync(paths.tokenPath, { force: true });
    throw error;
  }
  chmodSync(paths.socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(paths.socketPath, { force: true });
          rmSync(paths.tokenPath, { force: true });
          resolve();
        });
      }),
  };
}

export type DaemonControlReply =
  | { state: 'stopped'; holder: LockOwner | null }
  | { state: 'running'; reply: Record<string, unknown> };

/**
 * Ask the install's daemon. No token or no listening socket means nothing serves this install;
 * a lock left behind is reported with its holder so a crashed process is visible.
 */
export async function requestDaemonControl(
  paths: DaemonControlPaths,
  op: DaemonControlOp,
  timeoutMs = 5_000
): Promise<DaemonControlReply> {
  let token: string;
  try {
    token = readFileSync(paths.tokenPath, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { state: 'stopped', holder: lockHolder(paths) };
  }
  return await new Promise<DaemonControlReply>((resolve, reject) => {
    const socket = connect(paths.socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`The daemon did not answer within ${timeoutMs} ms`));
    });
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, op })}\n`));
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('end', () => {
      try {
        resolve({ state: 'running', reply: JSON.parse(data) as Record<string, unknown> });
      } catch {
        reject(new Error('The daemon sent an unreadable reply'));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') {
        reject(error);
        return;
      }
      // Inside an event handler a throw would be uncaught; the caller gets it instead.
      try {
        resolve({ state: 'stopped', holder: lockHolder(paths) });
      } catch (holderError) {
        reject(holderError);
      }
    });
  });
}
