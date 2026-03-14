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
  const driver = process.env.MAMA_SQLITE_DRIVER || 'node-sqlite';

  if (driver !== 'node-sqlite' && driver !== 'auto') {
    throw new Error(`Unsupported SQLite driver "${driver}". MAMA now requires node:sqlite.`);
  }

  info('[db-adapter] Using node:sqlite adapter');
  return new SQLiteAdapter({ dbPath });
}
