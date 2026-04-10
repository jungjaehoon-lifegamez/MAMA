/**
 * SQLite wrapper for standalone using better-sqlite3.
 * API-compatible with the previous node:sqlite wrapper.
 */

import BetterSqlite3 from 'better-sqlite3';

export interface SQLiteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SQLiteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => SQLiteRunResult;
}

export type SQLiteDatabase = Database;

export default class Database {
  private db: BetterSqlite3.Database;
  readonly driver = 'better-sqlite3' as const;

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
  }

  prepare(sql: string): SQLiteStatement {
    const stmt = this.db.prepare(sql);
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => {
        const result = stmt.run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    return this.db.pragma(sql, options);
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return this.db.transaction(fn) as unknown as T;
  }

  close(): void {
    this.db.close();
  }

  get open(): boolean {
    return this.db.open;
  }
}
