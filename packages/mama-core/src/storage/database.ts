/**
 * Database lifetime.
 *
 * `openDatabase` returns a handle to one database. It does not register itself
 * anywhere, so two calls give two independent databases and a caller always
 * knows which one it holds. `db-manager.ts` keeps a single handle for the
 * callers that still reach for a module-level connection; nothing here depends
 * on that handle existing.
 *
 * @module storage/database
 */

import os from 'node:os';
import path from 'node:path';
import { createAdapter } from '../db-adapter/index.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { assertEmbeddingSchemeCurrent } from '../db-manager.js';
import { info } from '../debug-logger.js';
import { logComplete, logSearching } from '../progress-indicator.js';

/** Migrations ship beside the compiled output, two levels up from `dist/storage`. */
export const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

/** The path a normal install writes to. A test process must never open it. */
const REAL_USER_DB_PATH = path.join(os.homedir(), '.claude', 'mama-memory.db');

export interface OpenDatabaseOptions {
  /** Where to open. Falls back to the adapter's own resolution when omitted. */
  path?: string;
  /** Directory holding the migration files. Defaults to the shipped one. */
  migrationsDir?: string;
}

export interface DatabaseHandle {
  adapter: DatabaseAdapter;
  /** The value `connect()` returned, for callers that still need the raw driver. */
  connection: unknown;
  /** Where this handle actually opened, or a description when the adapter cannot say. */
  dbPath: string;
  close: () => Promise<void>;
}

export function isTestMode(): boolean {
  return Boolean(
    process.env.MAMA_TEST_MODE || process.env.VITEST || process.env.NODE_ENV === 'test'
  );
}

function expandHomePath(value: string): string {
  const home = os.homedir();
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/')) {
    return path.join(home, value.slice(2));
  }
  return value.replaceAll('${HOME}', home);
}

/**
 * Refuse to open the real user database from a test process.
 *
 * A test that reaches the real database corrupts the owner's memory and the
 * failure surfaces far from the cause, so this throws before `connect()`.
 */
export function assertTestProcessIsNotUsingRealDb(
  effectivePath?: string,
  effectivePathSource = 'adapter'
): void {
  if (!isTestMode()) {
    return;
  }

  const configuredPaths = [
    { name: 'MAMA_DB_PATH', value: process.env.MAMA_DB_PATH },
    { name: 'MAMA_DATABASE_PATH', value: process.env.MAMA_DATABASE_PATH },
  ];
  if (effectivePath) {
    configuredPaths.push({ name: effectivePathSource, value: effectivePath });
  }

  for (const configuredPath of configuredPaths) {
    if (!configuredPath.value) {
      continue;
    }

    const resolvedPath = path.resolve(expandHomePath(configuredPath.value));
    if (resolvedPath === path.resolve(REAL_USER_DB_PATH)) {
      throw new Error(
        `[db-boundary] Refusing to open real DB ${REAL_USER_DB_PATH} ` +
          `from a test process (${configuredPath.name}=${configuredPath.value}). ` +
          'Set MAMA_DB_PATH to a temporary path first.'
      );
    }
  }
}

export function resolveAdapterDbPath(adapter: DatabaseAdapter): string | undefined {
  if (typeof adapter.getDbPath === 'function') {
    return adapter.getDbPath();
  }
  return adapter.dbPath;
}

/**
 * Open one database: connect, migrate, and verify the embedding scheme.
 *
 * Throws if any step fails. Nothing partially opened is returned, so a caller
 * that receives a handle holds a migrated database it can use.
 */
export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<DatabaseHandle> {
  assertTestProcessIsNotUsingRealDb(options.path, 'openDatabase({ path })');

  logSearching('Initializing database...');

  const adapter = createAdapter(
    options.path ? { dbPath: options.path } : {}
  ) as unknown as DatabaseAdapter;
  assertTestProcessIsNotUsingRealDb(resolveAdapterDbPath(adapter), 'adapter.getDbPath()');

  let connection: unknown;
  try {
    connection = await adapter.connect();
    await adapter.runMigrations(options.migrationsDir ?? MIGRATIONS_DIR);

    // New tables and rows exist only after migrations run.
    if (typeof adapter.reloadVectorCache === 'function') {
      adapter.reloadVectorCache();
    }

    // Fail loud on legacy vectors meeting current code.
    assertEmbeddingSchemeCurrent(adapter);
  } catch (error) {
    try {
      adapter.disconnect();
    } catch {
      // The open already failed; a disconnect error would only mask it.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize database: ${message}`);
  }

  info(`[storage/database] Database opened (${adapter.constructor.name})`);
  logComplete('Database ready');

  return {
    adapter,
    connection,
    dbPath: resolveAdapterDbPath(adapter) ?? `${adapter.constructor.name} (path unavailable)`,
    close: async () => {
      await adapter.disconnect();
    },
  };
}
