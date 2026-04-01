/**
 * SQLite wrapper for standalone using better-sqlite3.
 */

type NonPromise<T> = T extends Promise<unknown> ? never : T;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const BetterSqlite3Module = require('better-sqlite3') as
  | BetterSQLite3Ctor
  | { default: BetterSQLite3Ctor };
const BetterSqlite3 =
  'default' in BetterSqlite3Module ? BetterSqlite3Module.default : BetterSqlite3Module;

interface BetterSQLite3Db {
  prepare(sql: string): BetterSQLite3Stmt;
  exec(sql: string): void;
  close(): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T extends (...args: never[]) => NonPromise<unknown>>(fn: T): T;
  readonly open: boolean;
}

interface BetterSQLite3Stmt {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

type BetterSQLite3Ctor = new (path: string) => BetterSQLite3Db;

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
  private db: BetterSQLite3Db;
  readonly driver = 'better-sqlite3' as const;

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
  }

  prepare(sql: string): SQLiteStatement {
    const stmt = this.db.prepare(sql);
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => stmt.run(...params),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    return this.db.pragma(sql, options);
  }

  transaction<T extends (...args: never[]) => NonPromise<unknown>>(fn: T): T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }

  get open(): boolean {
    return this.db.open;
  }
}
