/**
 * Size-rotated log files. When a file would pass its limit, it is compressed to `<file>.1.gz`, the
 * older archives move up one number, and the oldest beyond `keep` is removed. Everything is
 * synchronous: a log line is on disk when write returns, and lines cannot reorder across a
 * rotation. Compressing a full file blocks for roughly a tenth of a second once per limit.
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
  writeFileSync,
  writeSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';

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
 * Compress the file into its first archive and leave no file behind. The archive is written under a
 * temporary name and renamed, so a crash leaves either the old archives or the new one, never a
 * half-written one; at worst the file's lines are in both the archive and the file.
 */
export function rotateLogFile(path: string, keep: number): void {
  if (!existsSync(path)) return;
  rmSync(archivePath(path, keep), { force: true });
  for (let n = keep - 1; n >= 1; n -= 1) {
    if (existsSync(archivePath(path, n)))
      renameSync(archivePath(path, n), archivePath(path, n + 1));
  }
  const temporary = `${archivePath(path, 1)}.tmp`;
  writeFileSync(temporary, gzipSync(readFileSync(path)), { mode: 0o600 });
  renameSync(temporary, archivePath(path, 1));
  rmSync(path, { force: true });
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

/** One open log file, rotated by size, owner-only. */
export function openRotatingLog(path: string, limits: RotatingLogLimits): RotatingLog {
  let fd = -1;
  let size = 0;
  const open = (): void => {
    fd = openSync(path, 'a', 0o600);
    // The service manager or an older daemon may have created it with the user's umask.
    fchmodSync(fd, 0o600);
    size = fstatSync(fd).size;
  };
  open();
  if (size > limits.maxBytes) {
    closeSync(fd);
    rotateLogFile(path, limits.keep);
    open();
  }
  return {
    write(chunk) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (size > 0 && size + bytes.length > limits.maxBytes) {
        closeSync(fd);
        rotateLogFile(path, limits.keep);
        open();
      }
      writeSync(fd, bytes);
      size += bytes.length;
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
