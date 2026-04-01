/**
 * SQLite database adapter compatibility export.
 *
 * MAMA standardizes on better-sqlite3 (FTS5 built-in, sync API).
 * Keeps the SQLiteAdapter symbol so existing imports continue to work.
 */

import { NodeSQLiteAdapter } from './node-sqlite-adapter.js';

interface SQLiteAdapterConfig {
  dbPath?: string;
}

export class SQLiteAdapter extends NodeSQLiteAdapter {
  constructor(config: SQLiteAdapterConfig = {}) {
    super(config);
  }
}

export default SQLiteAdapter;
