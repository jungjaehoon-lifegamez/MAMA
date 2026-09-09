/** TG-05/TG-06: Markdown is a recoverable projection of committed procedure state.
 * The caller owns DB revision/history and persists desired text before calling.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function hashProcedureDocument(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ProcedureProjectionInput {
  path: string;
  text: string;
  expectedFileHash: string | null;
  onPublished: (hash: string) => void;
  /** Trusted host port: run synchronously inside the canonical store's exclusive
   * write transaction, including acknowledgement. SQLite releases this lock on
   * process death. Never populate this callback from model-authored input.
   */
  serialize?: (publish: () => ProcedureProjectionResult) => ProcedureProjectionResult;
  /** Fault-injection seam, called after preparing the unique temporary file. */
  beforePublish?: () => void;
}
export interface ProcedureProjectionResult {
  status: 'saved' | 'projected' | 'conflict';
  hash: string;
  reason?: string;
}

function currentHash(path: string): string | null {
  return existsSync(path) ? hashProcedureDocument(readFileSync(path, 'utf8')) : null;
}

/** Writers share an exclusive lock; unexpected file changes never become a new
 * baseline implicitly. A process-killed lock needs explicit operator recovery;
 * it is deliberately never stolen on a timeout from a potentially live writer.
 */
export function publishProcedureProjection(
  input: ProcedureProjectionInput
): ProcedureProjectionResult {
  const hash = hashProcedureDocument(input.text);
  try {
    return input.serialize
      ? input.serialize(() => publishUnderLock(input, true))
      : publishUnderLock(input, false);
  } catch {
    // Let the transaction observe the exception and roll back first. Canonical
    // content was committed before this publication attempt, so it stays saved.
    return { status: 'saved', hash, reason: 'projection_publish_pending' };
  }
}

function publishUnderLock(
  input: ProcedureProjectionInput,
  externallySerialized: boolean
): ProcedureProjectionResult {
  const hash = hashProcedureDocument(input.text);
  const lockPath = `${input.path}.projection-lock`;
  const tempPath = `${input.path}.${randomUUID()}.tmp`;
  let lock: number | undefined;
  try {
    mkdirSync(dirname(input.path), { recursive: true });
    if (!externallySerialized) {
      try {
        lock = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { status: 'conflict', hash, reason: 'projection_writer_locked' };
        }
        throw error;
      }
    }
    const observed = currentHash(input.path);
    // Publication may have succeeded before the DB acknowledgement failed.
    if (observed === hash) {
      input.onPublished(hash);
      return { status: 'projected', hash };
    }
    if (observed !== input.expectedFileHash) {
      return { status: 'conflict', hash, reason: 'projection_file_changed' };
    }
    writeFileSync(tempPath, input.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    input.beforePublish?.();
    if (currentHash(input.path) !== input.expectedFileHash) {
      return { status: 'conflict', hash, reason: 'projection_file_changed' };
    }
    renameSync(tempPath, input.path);
    input.onPublished(hash);
    return { status: 'projected', hash };
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}
