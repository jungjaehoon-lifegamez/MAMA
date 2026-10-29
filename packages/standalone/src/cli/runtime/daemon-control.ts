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
import { connect, createServer, type Server, type Socket } from 'node:net';
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

/** A lock and the file naming its holder: the install's, or another one such as `update.lock`. */
export type LockPaths = Pick<DaemonControlPaths, 'lockPath' | 'holderPath'>;

export function daemonControlPaths(mamaRoot: string): DaemonControlPaths {
  const runtimeRoot = join(mamaRoot, 'runtime');
  return {
    lockPath: join(runtimeRoot, 'daemon.lock'),
    holderPath: join(runtimeRoot, 'daemon.holder.json'),
    socketPath: join(mamaRoot, 'daemon.sock'),
    tokenPath: join(runtimeRoot, 'daemon.token'),
  };
}

/** The journal an interrupted `mama restore` leaves; nothing may run on the install while it is there. */
export function restoreJournalPath(mamaRoot: string): string {
  return join(mamaRoot, 'backups', '.restore-journal.json');
}

/** A half-switched install: a refusal, not a failure, so a service does not restart into it. */
export class RestorePendingError extends CliInputError {
  readonly code = 'MAMA_RESTORE_PENDING';
  constructor() {
    super('An interrupted restore is unfinished; run mama restore --rollback first');
    this.name = 'RestorePendingError';
  }
}

/** Refuse to work on an install while a restore journal is open. */
export function refuseWhileRestoring(mamaRoot: string): void {
  if (existsSync(restoreJournalPath(mamaRoot))) throw new RestorePendingError();
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
  paths: LockPaths,
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
export function lockHolder(paths: LockPaths): LockOwner | null {
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

export type DaemonControlOp = 'status' | 'stop' | 'probe' | 'drain' | 'release';

/** What a drain waits for: model runs of this boot still running, and inputs a delivery owns. */
export interface DrainCounts {
  readonly running: number;
  readonly claimed: number;
}

/** Claims held for one drain connection, from `hold` until `release`. */
export interface ClaimHold {
  /** How long the drain may wait, fixed when the hold began. */
  readonly boundMs: number;
  counts(): DrainCounts;
  release(): void;
}

export interface DaemonControlHandlers {
  status(): Promise<Record<string, unknown>> | Record<string, unknown>;
  stop(): void;
  /** One real backend turn; it throws what failed. */
  probe(): Promise<Record<string, unknown>>;
  /** Stop claiming new work until the hold is released; it throws when it cannot hold. */
  hold(): ClaimHold;
  /**
   * End the hold an update candidate boots with (docs/development/work/update.md, step 14);
   * `held` says whether there was one.
   */
  release(): { held: boolean };
}

export interface DaemonControlServer {
  close(): Promise<void>;
}

const MAX_REQUEST_BYTES = 4096;

/** A drain repeats its counts this often while they stay the same, so a waiting terminal sees why. */
export const DRAIN_REPEAT_MS = 30_000;

/**
 * Serve status, stop, a backend probe, a drain and an update's release to the CLI. Only the lock holder calls this, so
 * removing a socket left by a dead holder never removes a live one. Each boot writes a new token; a
 * request without it is refused. Every op but `drain` answers once and ends the connection. A
 * drain keeps its connection open and holds claims for as long as it stays open: it sends its
 * counts as lines until nothing runs, then says idle and goes on holding, so the stop that follows
 * starts nothing new; a client that dies lets go. Past the hold's bound it sends the counts and
 * ends, which lets go too.
 */
export async function startDaemonControl(
  paths: DaemonControlPaths,
  handlers: DaemonControlHandlers,
  /** How long a client may take to send its request; tests shorten it. */
  requestTimeoutMs = 5_000,
  /** How often a drain counts what still runs; tests shorten it. */
  drainPollMs = 1_000
): Promise<DaemonControlServer> {
  const token = randomBytes(32).toString('hex');
  rmSync(paths.tokenPath, { force: true });
  writeFileSync(paths.tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
  rmSync(paths.socketPath, { force: true });
  const expected = Buffer.from(token, 'utf8');
  // Open drains: the server's close waits for every connection, and a drain ends only when its
  // client lets go, so closing the server ends them.
  const drains = new Set<Socket>();
  const server: Server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
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
      // The deadline is for sending a request; answering a probe takes a model turn.
      socket.setTimeout(0);
      void answer(line, socket).then(
        (reply) => {
          if (reply) socket.end(`${JSON.stringify(reply)}\n`);
        },
        (error: unknown) =>
          socket.end(
            `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
          )
      );
    });
  });
  function drain(socket: Socket): void {
    const hold = handlers.hold();
    drains.add(socket);
    const started = Date.now();
    let last = '';
    let lastAt = 0;
    const timer = setInterval(tick, drainPollMs);
    socket.once('close', () => {
      clearInterval(timer);
      drains.delete(socket);
      hold.release();
    });
    function tick(): void {
      // A throw here would escape the timer and end the daemon; the client gets it instead.
      try {
        const counts = hold.counts();
        const idle = counts.running === 0 && counts.claimed === 0;
        if (!idle && Date.now() - started >= hold.boundMs) {
          clearInterval(timer);
          socket.end(
            `${JSON.stringify({ ok: false, error: 'drain bound passed', bound: hold.boundMs, ...counts })}\n`
          );
          return;
        }
        const line = JSON.stringify({ ok: true, drain: { ...counts, bound: hold.boundMs, idle } });
        if (line !== last || Date.now() - lastAt >= DRAIN_REPEAT_MS) {
          socket.write(`${line}\n`);
          last = line;
          lastAt = Date.now();
        }
        // Nothing new is claimed while held, so idle stays idle; the hold goes on until the client
        // closes or the daemon stops.
        if (idle) clearInterval(timer);
      } catch (error) {
        clearInterval(timer);
        socket.end(
          `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
        );
      }
    }
    tick();
  }
  async function answer(line: string, socket: Socket): Promise<Record<string, unknown> | null> {
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
    if (request.op === 'probe') return { ok: true, probe: await handlers.probe() };
    if (request.op === 'release') return { ok: true, ...handlers.release() };
    if (request.op === 'drain') {
      drain(socket);
      return null;
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
        for (const socket of drains) socket.destroy();
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

/** One drain line: what still runs, the hold's bound, and whether nothing runs any more. */
export interface DrainProgress extends DrainCounts {
  readonly bound: number;
  readonly idle: boolean;
}

export type DrainOutcome =
  /** Nothing runs; claims stay held until `release`. */
  | { kind: 'idle' }
  /** The bound passed first; the daemon let go and changed nothing. */
  | { kind: 'bound'; bound: number; running: number; claimed: number }
  | { kind: 'refused'; error: string }
  /** The daemon stopped answering the drain; this side let go. */
  | { kind: 'silent'; error: string }
  /** The connection ended before idle: the daemon stopped or died. */
  | { kind: 'closed' };

export interface DaemonDrain {
  readonly outcome: Promise<DrainOutcome>;
  /** End the hold; the daemon claims again. */
  release(): void;
}

/** How long a drain's client waits on the daemon; tests shorten them. */
export interface DrainDeadlines {
  /** For the first line, which the daemon sends as soon as it holds. */
  firstMs?: number;
  /** Between lines: the daemon repeats its counts every 30 s, so two missed repeats. */
  silenceMs?: number;
  /** Past the daemon's own bound, which the daemon should have ended the drain at. */
  graceMs?: number;
}

/**
 * Hold the install's claims for as long as the returned drain is not released, and report each
 * count the daemon sends. Null when nothing serves the install. The bound is the daemon's, but a
 * wedged daemon would enforce nothing, so this side gives up too when the daemon goes quiet or
 * outlives its own bound.
 */
export async function drainDaemon(
  paths: DaemonControlPaths,
  onProgress: (progress: DrainProgress) => void,
  deadlines: DrainDeadlines = {}
): Promise<DaemonDrain | null> {
  const firstMs = deadlines.firstMs ?? 5_000;
  const silenceMs = deadlines.silenceMs ?? 2 * DRAIN_REPEAT_MS + 5_000;
  const graceMs = deadlines.graceMs ?? 30_000;
  let token: string;
  try {
    token = readFileSync(paths.tokenPath, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
  return await new Promise<DaemonDrain | null>((resolve, reject) => {
    const socket = connect(paths.socketPath);
    let connected = false;
    let settled = false;
    let silence: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let resolveOutcome!: (outcome: DrainOutcome) => void;
    const outcome = new Promise<DrainOutcome>((done) => {
      resolveOutcome = done;
    });
    const settle = (result: DrainOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(silence);
      clearTimeout(watchdog);
      resolveOutcome(result);
    };
    const quiet = (ms: number, error: string): void => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        settle({ kind: 'silent', error });
        socket.destroy();
      }, ms);
    };
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ token, op: 'drain' })}\n`);
      quiet(firstMs, `the daemon did not answer the drain within ${firstMs} ms`);
      resolve({ outcome, release: () => socket.destroy() });
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(line) as Record<string, unknown>;
        } catch {
          settle({ kind: 'refused', error: 'The daemon sent an unreadable reply' });
          socket.destroy();
          return;
        }
        if (reply.ok !== true) {
          settle(
            reply.error === 'drain bound passed'
              ? {
                  kind: 'bound',
                  bound: Number(reply.bound),
                  running: Number(reply.running),
                  claimed: Number(reply.claimed),
                }
              : { kind: 'refused', error: String(reply.error) }
          );
          continue;
        }
        const progress = reply.drain as DrainProgress;
        if (watchdog === undefined) {
          watchdog = setTimeout(() => {
            settle({
              kind: 'silent',
              error: `the daemon did not end the drain at its bound of ${progress.bound} ms`,
            });
            socket.destroy();
          }, progress.bound + graceMs);
        }
        quiet(silenceMs, `the daemon sent nothing on the drain for ${silenceMs} ms`);
        onProgress(progress);
        if (progress.idle) settle({ kind: 'idle' });
      }
    });
    // A settled outcome stays; a close before any answer is the daemon going away.
    socket.on('close', () => settle({ kind: 'closed' }));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (connected) return; // the close that follows settles the outcome
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(null);
      else reject(error);
    });
  });
}
