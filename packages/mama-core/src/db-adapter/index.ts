/**
 * Database Adapter Factory (SQLite-only)
 *
 * MAMA Plugin uses SQLite exclusively for local storage.
 * PostgreSQL support is only available in the legacy mcp-server.
 *
 * @module db-adapter
 */

import { info } from '../debug-logger.js';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { NodeSQLiteAdapter } from './node-sqlite-adapter.js';
import { DatabaseAdapter, type VectorSearchResult, type RunResult } from './base-adapter.js';
import type { Statement } from './statement.js';

export { DatabaseAdapter, SQLiteAdapter, NodeSQLiteAdapter };
export type { Statement, VectorSearchResult, RunResult };

export interface AdapterConfig {
  dbPath?: string;
}

/**
 * Create SQLite database adapter
 *
 * @param config - Database configuration
 * @returns Configured SQLite adapter instance
 */
export function createAdapter(config: AdapterConfig = {}): DatabaseAdapter {
  const dbPath = config.dbPath || process.env.MAMA_DB_PATH;
  const driver = process.env.MAMA_SQLITE_DRIVER || 'auto';

  if (driver === 'better-sqlite3') {
    info('[db-adapter] Using better-sqlite3 adapter');
    return new SQLiteAdapter({ dbPath });
  }

  if (driver === 'node-sqlite') {
    info('[db-adapter] Using node:sqlite adapter');
    return new NodeSQLiteAdapter({ dbPath });
  }

  try {
    const majorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
    if (majorVersion >= 22) {
      info('[db-adapter] Using node:sqlite adapter (auto)');
      return new NodeSQLiteAdapter({ dbPath });
    }
  } catch {
    // Fall through to better-sqlite3.
  }

  info('[db-adapter] Using better-sqlite3 adapter (auto fallback)');
  return new SQLiteAdapter({ dbPath });
}
