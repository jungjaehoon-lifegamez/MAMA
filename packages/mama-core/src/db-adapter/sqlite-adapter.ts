/**
 * SQLite database adapter compatibility export.
 *
 * MAMA now standardizes on Node's built-in node:sqlite runtime. Keep the
 * legacy SQLiteAdapter symbol so existing imports continue to work.
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
