import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  statSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect, createServer, type Server } from 'node:net';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { CliInputError } from '../prompt.js';

/**
 * One install runs one process that owns its stores: the daemon, or a replay or backfill booted
 * the same way, or register-owner. The lock file is that process's claim; the control socket lets
 * the CLI ask the holder for its status or a stop. The lock and the token live under
 * `<root>/runtime/`, which the agents' native reads deny, so a session that reaches the socket
 * still cannot use it. The socket sits beside `runtime.sock` at the root, so it fits the same
 * AF_UNIX path limit (104 bytes on macOS).
 */

export interface DaemonControlPaths {
  readonly lockPath: string;
  readonly socketPath: string;
  readonly tokenPath: string;
}

export function daemonControlPaths(mamaRoot: string): DaemonControlPaths {
  const runtimeRoot = join(mamaRoot, 'runtime');
  return {
    lockPath: join(runtimeRoot, 'daemon.lock'),
    socketPath: join(mamaRoot, 'daemon.sock'),
    tokenPath: join(runtimeRoot, 'daemon.token'),
  };
}

export interface LockOwner {
  readonly pid: number;
  readonly command: string;
  readonly startedAt: number;
  readonly nonce: string;
  /** When the machine booted, so a lock left before a reboot is never mistaken for a live one. */
  readonly bootTime?: number;
}

/** A CLI input error: the message names the holder and the fix, and carries no secret. */
export class InstallBusyError extends CliInputError {
  readonly code = 'MAMA_INSTALL_BUSY';
  constructor(
    readonly holder: LockOwner,
    lockPath: string
  ) {
    super(
      `MAMA is already running here (${holder.command}, pid ${holder.pid}; ${lockPath}); stop it first: mama stop`
    );
    this.name = 'InstallBusyError';
  }
}

export interface InstallLock {
  readonly owner: LockOwner;
  release(): void;
}

function readOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>;
    if (
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.command === 'string' &&
      typeof value.startedAt === 'number' &&
      typeof value.nonce === 'string'
    ) {
      return value as LockOwner;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    return null;
  }
}

/** A signal of 0 tests for a process without touching it; EPERM means it exists as another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The machine's boot time in milliseconds, to the second. */
export function machineBootTime(): number {
  return Math.round((Date.now() - uptime() * 1000) / 1000) * 1000;
}

/**
 * When a process started: Linux exposes it as the creation time of its /proc entry; macOS through
 * `ps`. Null when neither answers, and the caller then relies on the boot time and the pid.
 */
export function processStartTime(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      return statSync(`/proc/${pid}`).ctimeMs;
    } catch {
      return null;
    }
  }
  // C locale: ps prints the start in a fixed English form that Date.parse reads.
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error || result.status !== 0) return null;
  const started = Date.parse(result.stdout.trim());
  return Number.isFinite(started) ? started : null;
}

export interface HolderProbe {
  alive(pid: number): boolean;
  startTime(pid: number): number | null;
  bootTime(): number;
}

const systemProbe: HolderProbe = {
  alive: processAlive,
  startTime: processStartTime,
  bootTime: machineBootTime,
};

/**
 * A lock is held only by the process that wrote it: same machine boot, pid alive, and that pid's
 * process started no later than the lock (a pid reused afterwards belongs to another process).
 */
export function holderLive(owner: LockOwner, probe: HolderProbe = systemProbe): boolean {
  if (owner.bootTime !== undefined && Math.abs(owner.bootTime - probe.bootTime()) > 60_000) {
    return false;
  }
  if (!probe.alive(owner.pid)) return false;
  const started = probe.startTime(owner.pid);
  return started === null || started <= owner.startedAt + 5_000;
}

/**
 * Take the install's lock. The lock is created by a hard link of a complete file, so no reader
 * sees a half-written owner. A lock whose process is gone (or whose content is unreadable) is
 * moved aside under a unique name and re-read there before it is removed, so two processes that
 * both find the same dead lock cannot remove each other's new one.
 */
export function acquireInstallLock(
  paths: DaemonControlPaths,
  command: string,
  probe: HolderProbe = systemProbe
): InstallLock {
  mkdirSync(join(paths.lockPath, '..'), { recursive: true, mode: 0o700 });
  const owner: LockOwner = {
    pid: process.pid,
    command,
    startedAt: Date.now(),
    nonce: randomUUID(),
    bootTime: probe.bootTime(),
  };
  const staged = `${paths.lockPath}.${owner.nonce}`;
  writeFileSync(staged, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        linkSync(staged, paths.lockPath);
        return {
          owner,
          release: () => releaseInstallLock(paths, owner),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      let current: LockOwner | null;
      try {
        current = readOwner(paths.lockPath);
      } catch {
        continue; // Removed between link and read; try again.
      }
      if (current !== null && holderLive(current, probe)) {
        throw new InstallBusyError(current, paths.lockPath);
      }
      const aside = `${paths.lockPath}.stale.${randomUUID()}`;
      try {
        renameSync(paths.lockPath, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let moved: LockOwner | null = null;
      try {
        moved = readOwner(aside);
      } catch {
        moved = null;
      }
      if (moved !== null && moved.nonce !== current?.nonce) {
        // Another process replaced the dead lock first; give its live lock back.
        try {
          linkSync(aside, paths.lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      rmSync(aside, { force: true });
    }
    throw new Error('Could not take the install lock: it kept changing');
  } finally {
    rmSync(staged, { force: true });
  }
}

function releaseInstallLock(paths: DaemonControlPaths, owner: LockOwner): void {
  try {
    const current = readOwner(paths.lockPath);
    if (current?.nonce === owner.nonce) unlinkSync(paths.lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        resolve({ state: 'stopped', holder: lockHolder(paths) });
      } else {
        reject(error);
      }
    });
  });
}

/** The lock's owner when it still holds the install; a dead owner's lock is not a holder. */
export function lockHolder(
  paths: DaemonControlPaths,
  probe: HolderProbe = systemProbe
): LockOwner | null {
  try {
    const owner = readOwner(paths.lockPath);
    return owner !== null && holderLive(owner, probe) ? owner : null;
  } catch {
    return null;
  }
}
