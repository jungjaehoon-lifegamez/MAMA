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

import path from 'node:path';
import { createAdapter } from '../db-adapter/index.js';
import { NewerSchemaError } from '../db-adapter/node-sqlite-adapter.js';
import type { DatabaseInstance } from '../db-manager.js';
import { assertEmbeddingSchemeCurrent } from '../db-manager.js';
import { info } from '../debug-logger.js';
import { logComplete, logSearching } from '../progress-indicator.js';

/** Migrations ship beside the compiled output, two levels up from `dist/storage`. */
export const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

export interface OpenDatabaseOptions {
  /** Where to open. Falls back to the adapter's own resolution when omitted. */
  path?: string;
  /** Directory holding the core's migration files. Defaults to the shipped one. */
  migrationsDir?: string;
  /**
   * Migrations this consumer brings of its own, run after the core's.
   *
   * A package that needs a table has somewhere to put it other than inside the
   * core. Each source namespaces its own version numbers, so the core's next
   * number is not spoken for by somebody else.
   */
  migrations?: ReadonlyArray<{ name: string; dir: string }>;
  /**
   * Refuse a database whose schema, for any source, is newer than this version's migrations,
   * before anything writes to it (NewerSchemaError). Off by default: consumers that share one
   * database at different core versions would refuse each other until they run one core.
   */
  refuseNewerSchema?: boolean;
}

export interface DatabaseHandle {
  adapter: DatabaseInstance;
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

/**
 * A path a consumer states must already be resolved.
 *
 * The core used to expand `~` and `${HOME}` itself, which made it the thing that
 * decides what home means. Two consumers with different homes then got the same
 * answer from a library neither of them configured. Expansion belongs to whoever owns
 * the home directory; this only refuses to guess.
 */
function requireResolvedPath(value: string, source: string): string {
  if (value === '~' || value.startsWith('~/') || value.includes('${HOME}')) {
    throw new Error(
      `[db-boundary] ${source} is not a resolved path (${value}). ` +
        'Expand it where the home directory is known and state the result.'
    );
  }
  return path.resolve(value);
}

/**
 * Databases a product has declared as its live one.
 *
 * The core used to hold one such path itself, `~/.claude/mama-memory.db`, which meant
 * a shared library knew where one product kept its data in order to protect it. Each
 * product declares its own now, and the guard below refuses all of them.
 */
const productionDatabasePaths = new Set<string>();

/**
 * Declare where this product's live database is, as a resolved absolute path.
 * Call once, before opening anything.
 */
export function declareProductionDatabasePath(value: string): void {
  productionDatabasePaths.add(requireResolvedPath(value, 'the declared production database path'));
}

/** Test seam: forget what was declared. */
export function clearProductionDatabasePaths(): void {
  productionDatabasePaths.clear();
}

/**
 * Refuse, in a test process, to open a database nobody named or one a product
 * declared as live.
 *
 * This used to compare against one hard-coded path, `~/.claude/mama-memory.db`, which
 * meant the core held a product's data location in order to protect it. The rule is
 * the same and says no product's name: a test that did not state where it wanted to
 * write is about to write somewhere it did not choose, and that failure surfaces far
 * from its cause.
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

  const named = configuredPaths.find((configuredPath) => Boolean(configuredPath.value));
  if (!named) {
    throw new Error(
      '[db-boundary] Refusing to open an unnamed database from a test process. ' +
        'Set MAMA_DB_PATH to a temporary path first.'
    );
  }

  for (const configuredPath of configuredPaths) {
    if (!configuredPath.value) {
      continue;
    }
    const resolvedPath = requireResolvedPath(configuredPath.value, configuredPath.name);
    if (productionDatabasePaths.has(resolvedPath)) {
      throw new Error(
        `[db-boundary] Refusing to open the live database ${resolvedPath} ` +
          `from a test process (${configuredPath.name}=${configuredPath.value}). ` +
          'Set MAMA_DB_PATH to a temporary path first.'
      );
    }
  }
}

export function resolveAdapterDbPath(adapter: DatabaseInstance): string | undefined {
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
  ) as unknown as DatabaseInstance;
  assertTestProcessIsNotUsingRealDb(resolveAdapterDbPath(adapter), 'adapter.getDbPath()');

  let connection: unknown;
  try {
    connection = await adapter.connect();
    await adapter.runMigrations(
      [
        { name: 'core', dir: options.migrationsDir ?? MIGRATIONS_DIR },
        ...(options.migrations ?? []),
      ],
      { refuseNewer: options.refuseNewerSchema === true }
    );

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
    // A newer schema is a refusal with its own code, not an initialization failure.
    if (error instanceof NewerSchemaError) throw error;
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
