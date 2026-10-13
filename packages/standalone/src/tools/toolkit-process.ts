import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const signals = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const;
const cleanups = new Map<() => void, boolean>();
const handlers = new Map<NodeJS.Signals, () => void>();

/** Kill command groups before releasing their locks, even when no finally can run. */
export function onToolkitSignal(cleanup: () => void, options: { exit?: boolean } = {}): () => void {
  if (!cleanups.size) {
    for (const [signal, code] of Object.entries(signals)) {
      const handler = () => {
        let exit = false;
        for (const [release, exitOnSignal] of [...cleanups].reverse()) {
          exit ||= exitOnSignal;
          try {
            release();
          } catch (error) {
            process.stderr.write(`Document toolkit cleanup failed: ${String(error)}\n`);
          }
        }
        // Daemon shutdown owns its async stop. Only the host install CLI requests exit.
        if (exit) process.exit(code);
      };
      handlers.set(signal as NodeJS.Signals, handler);
      process.on(signal, handler);
    }
  }
  cleanups.set(cleanup, options.exit === true);
  return () => {
    cleanups.delete(cleanup);
    if (!cleanups.size) {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      handlers.clear();
    }
  };
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM still proves that the process exists. Other errors must be visible.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

export function liveToolkitLease(path: string): boolean {
  let owner: string;
  try {
    owner = readFileSync(path, 'utf8');
  } catch (error) {
    // A render released its lease between the directory scan and this read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return pidIsAlive(Number(owner.trim()));
}

/** Publish a nonempty lock atomically; unique owner files make concurrent stale recovery safe. */
export function tryToolkitLock(path: string): (() => void) | null {
  const candidate = mkdtempSync(`${path}.`);
  const owner = `${process.pid}-${randomUUID()}`;
  writeFileSync(join(candidate, owner), String(process.pid), { mode: 0o600 });
  const removeEmpty = () => {
    try {
      rmdirSync(path);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  };
  try {
    for (;;) {
      try {
        renameSync(candidate, path);
        const release = () => {
          rmSync(join(path, owner), { force: true });
          removeEmpty();
        };
        const unregister = onToolkitSignal(release);
        return () => {
          try {
            release();
          } finally {
            unregister();
          }
        };
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        try {
          if (!lstatSync(path).isDirectory()) {
            // Recover an earlier PID-file lock, without removing a replacement directory.
            if (liveToolkitLease(path)) return null;
            try {
              unlinkSync(path);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'EPERM' && lstatSync(path).isDirectory()) continue;
              if (!['ENOENT', 'EISDIR'].includes(code ?? '')) throw error;
            }
          } else {
            for (const name of readdirSync(path)) {
              const entry = join(path, name);
              if (liveToolkitLease(entry)) return null;
              // A newly published lock always has a different owner filename.
              rmSync(entry, { force: true });
            }
            removeEmpty();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}
