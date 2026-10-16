/**
 * Size-rotated log files. When a file would pass its limit, it is compressed to `<file>.1.gz`, the
 * older archives move up one number, the oldest beyond `keep` is removed, and the file is emptied in
 * place. It is never removed or replaced, so every descriptor open on it, such as a service manager
 * that still redirects into it, keeps writing to the file everyone reads. Everything is synchronous:
 * a log line is on disk when write returns, and lines cannot reorder across a rotation. Compressing a
 * full file blocks for roughly a tenth of a second once per limit.
 */
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

export interface RotatingLogLimits {
  /** Rotate before a write would take the file past this many bytes. */
  readonly maxBytes: number;
  /** Compressed archives kept beside the file. */
  readonly keep: number;
}

/** daemon.log: everything the daemon prints. */
export const DAEMON_LOG_LIMITS: RotatingLogLimits = { maxBytes: 10 * 1024 * 1024, keep: 5 };
/** security-events.jsonl: one line per viewer request or refused connection worth keeping. */
export const SECURITY_LOG_LIMITS: RotatingLogLimits = { maxBytes: 5 * 1024 * 1024, keep: 5 };

/** `<file>.<n>.gz`, the n-th newest archive. */
export function archivePath(path: string, n: number): string {
  return `${path}.${n}.gz`;
}

/**
 * Compress the file into its first archive and empty it. The new archive is written in full under a
 * temporary name before any kept archive moves, so a failure (a full disk) changes nothing; a crash
 * after that leaves at worst the file's lines in both the archive and the file.
 */
export function rotateLogFile(path: string, keep: number): void {
  if (!existsSync(path)) return;
  const temporary = `${archivePath(path, 1)}.tmp`;
  writeFileSync(temporary, gzipSync(readFileSync(path)), { mode: 0o600 });
  rmSync(archivePath(path, keep), { force: true });
  for (let n = keep - 1; n >= 1; n -= 1) {
    if (existsSync(archivePath(path, n)))
      renameSync(archivePath(path, n), archivePath(path, n + 1));
  }
  renameSync(temporary, archivePath(path, 1));
  truncateSync(path, 0);
}

/** The newest `count` lines across the file and its archives, oldest first. */
export function readLastLines(path: string, keep: number, count: number): string[] {
  const lines: string[] = [];
  for (let n = 0; n <= keep && lines.length < count; n += 1) {
    const source = n === 0 ? path : archivePath(path, n);
    if (!existsSync(source)) {
      if (n === 0) continue;
      break;
    }
    const raw = readFileSync(source);
    const text = (n === 0 ? raw : gunzipSync(raw)).toString('utf8');
    const own = text.split(/(?<=\n)/).filter((line) => line !== '');
    lines.unshift(...own.slice(-(count - lines.length)));
  }
  return lines;
}

/** Rotate first when this write would take the file past its limit. */
export function rotateBeforeWrite(path: string, bytes: number, limits: RotatingLogLimits): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size > 0 && size + bytes > limits.maxBytes) rotateLogFile(path, limits.keep);
}

export interface RotatingLog {
  write(chunk: string | Uint8Array): void;
  close(): void;
}

/**
 * One open log file, rotated by size, owner-only. Its size is read from the file at each write, so
 * lines another descriptor appends count too. A rotation that fails leaves the file as it is and
 * writing goes on: the failure is written to the log itself, and rotation is tried again once
 * another limit's worth has been written.
 */
export function openRotatingLog(path: string, limits: RotatingLogLimits): RotatingLog {
  const fd = openSync(path, 'a', 0o600);
  // The service manager or an older daemon may have created it with the user's umask.
  fchmodSync(fd, 0o600);
  let retryAt = limits.maxBytes;
  const rotateIfFull = (bytes: number): void => {
    const size = fstatSync(fd).size;
    if (size === 0 || size + bytes <= retryAt) return;
    try {
      rotateLogFile(path, limits.keep);
      retryAt = limits.maxBytes;
    } catch (error) {
      retryAt = size + limits.maxBytes;
      writeSync(
        fd,
        `[rotating-log] rotating ${path} failed; it grows until the next try: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  };
  rotateIfFull(0);
  return {
    write(chunk) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      rotateIfFull(bytes.length);
      writeSync(fd, bytes);
    },
    close() {
      closeSync(fd);
    },
  };
}

interface OutputStream {
  write: (...args: never[]) => boolean;
}

/**
 * Send everything the process prints through its own streams to the log. This is what Node code
 * writes (console and direct stream writes); output a native library writes to the descriptors
 * itself, and Node's own report of a fatal error, still go where the service manager points them.
 */
export function takeOverOutput(
  log: RotatingLog,
  streams: readonly OutputStream[] = [process.stdout, process.stderr]
): void {
  for (const stream of streams) {
    stream.write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void
    ): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;
      log.write(
        typeof chunk === 'string' && typeof encoding === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk
      );
      done?.();
      return true;
    }) as OutputStream['write'];
  }
}
