import { applyMigrationsThrough } from '@jungjaehoon/mama-core/test-utils';

import Database, { type SQLiteDatabase } from '../../src/sqlite.js';

export function makeOperatorVNextDb(): SQLiteDatabase {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // The standalone SQLite wrapper exposes the migration helper's required better-sqlite3 surface.
  applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
  return db;
}

export function countRows(db: SQLiteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
