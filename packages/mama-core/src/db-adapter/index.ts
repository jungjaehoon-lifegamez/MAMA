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
  // SQLiteAdapter (extends NodeSQLiteAdapter) auto-detects: better-sqlite3 (preferred, FTS5) → node:sqlite (fallback)
  info('[db-adapter] Creating SQLite adapter (auto-detect driver)');
  const dbPath = config.dbPath || process.env.MAMA_DB_PATH;
  return new SQLiteAdapter({ dbPath });
}
