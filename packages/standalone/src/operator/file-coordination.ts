/**
 * Cross-process serialization for a single filesystem-backed operator record.
 * SQLite's OS-held lock is crash-safe; unlike a pathname lock it never needs a
 * stale-owner heuristic or a lock-file unlink.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from '../sqlite.js';

const LOCK_WAIT_MS = 2_000;

function coordinationDatabasePath(path: string): string {
  return `${path}.lock.sqlite`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSqliteBusy(error: unknown): boolean {
  return isRecord(error) && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withFileCoordinationTransaction<T>(
  path: string,
  resourceName: string,
  operation: () => T
): T {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = coordinationDatabasePath(path);
  let database: Database | undefined;
  let transactionOpen = false;
  let result: T | undefined;
  let operationError: unknown;
  let rollbackError: unknown;
  let closeError: unknown;
  try {
    database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    database.pragma(`busy_timeout = ${LOCK_WAIT_MS}`);
    // Keep one coordination file: WAL would leave shared auxiliary paths.
    database.pragma('journal_mode = DELETE');
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    result = operation();
    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    operationError = error;
    if (transactionOpen && database !== undefined) {
      try {
        database.exec('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
    }
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch (closeFailure) {
        closeError = closeFailure;
      }
    }
  }

  if (rollbackError !== undefined || closeError !== undefined) {
    const cleanupFailure = rollbackError ?? closeError;
    throw new Error(
      `Unable to close ${resourceName} SQLite transaction after ${
        operationError === undefined ? 'operation' : formatError(operationError)
      }: ${formatError(cleanupFailure)}`
    );
  }
  if (operationError !== undefined) {
    if (isSqliteBusy(operationError)) {
      throw new Error(
        `Timed out waiting for ${resourceName} SQLite transaction after ${LOCK_WAIT_MS}ms`
      );
    }
    throw operationError;
  }
  return result as T;
}
