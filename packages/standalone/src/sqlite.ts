/**
 * SQLite compatibility wrapper for standalone.
 *
 * Prefers Node's built-in node:sqlite on Node 22+ and falls back to the
 * optional better-sqlite3 addon when explicitly requested or when node:sqlite
 * is unavailable.
 */

type BetterSqliteRunResult = { changes: number; lastInsertRowid: number | bigint };
type BetterSqliteStatementLike = {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => BetterSqliteRunResult;
};
type BetterSqliteDatabaseLike = {
  readonly open: boolean;
  pragma: (sql: string, options?: { simple?: boolean }) => unknown;
  prepare: (sql: string) => BetterSqliteStatementLike;
  exec: (sql: string) => void;
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
  close: () => void;
};
type BetterSqliteCtor = new (path: string) => BetterSqliteDatabaseLike;

type NodeSqliteRunResult = { changes: number; lastInsertRowid: number | bigint };
type NodeSqliteStatementLike = {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => NodeSqliteRunResult;
};
type NodeSqliteDatabaseLike = {
  prepare: (sql: string) => NodeSqliteStatementLike;
  exec: (sql: string) => void;
  close: () => void;
};
type NodeSqliteCtor = new (path: string) => NodeSqliteDatabaseLike;

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

let cachedBetterSqliteCtor: BetterSqliteCtor | null | undefined;
let cachedNodeSqliteCtor: NodeSqliteCtor | null | undefined;

function loadBetterSqliteCtor(): BetterSqliteCtor | null {
  if (cachedBetterSqliteCtor !== undefined) {
    return cachedBetterSqliteCtor;
  }

  try {
    const required = require('better-sqlite3') as BetterSqliteCtor | { default: BetterSqliteCtor };
    cachedBetterSqliteCtor = 'default' in required ? required.default : required;
  } catch {
    cachedBetterSqliteCtor = null;
  }

  return cachedBetterSqliteCtor;
}

function loadNodeSqliteCtor(): NodeSqliteCtor | null {
  if (cachedNodeSqliteCtor !== undefined) {
    return cachedNodeSqliteCtor;
  }

  try {
    ({ DatabaseSync: cachedNodeSqliteCtor } = require('node:sqlite') as {
      DatabaseSync: NodeSqliteCtor;
    });
  } catch {
    cachedNodeSqliteCtor = null;
  }

  return cachedNodeSqliteCtor;
}

class NodeSqliteConnection {
  private db: NodeSqliteDatabaseLike;
  private connected = true;

  constructor(db: NodeSqliteDatabaseLike) {
    this.db = db;
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
    const query = sql.trim().replace(/^PRAGMA\s+/i, '');
    const stmt = this.db.prepare(`PRAGMA ${query}`);
    if (options?.simple) {
      const row = stmt.get() as Record<string, unknown> | undefined;
      return row ? Object.values(row)[0] : undefined;
    }
    return stmt.all();
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const wrapped = ((...args: Parameters<T>) => {
      this.exec('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        this.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.exec('ROLLBACK');
        } catch {
          // Ignore rollback errors so original failure is preserved.
        }
        throw error;
      }
    }) as T;
    return wrapped;
  }

  close(): void {
    if (!this.connected) {
      return;
    }
    this.db.close();
    this.connected = false;
  }

  get open(): boolean {
    return this.connected;
  }
}

type SQLiteConnection = BetterSqliteDatabaseLike | NodeSqliteConnection;

function resolveDatabaseDriver():
  | { driver: 'node:sqlite'; ctor: NodeSqliteCtor }
  | { driver: 'better-sqlite3'; ctor: BetterSqliteCtor } {
  const configuredDriver = process.env.MAMA_SQLITE_DRIVER || 'auto';
  const nodeCtor = loadNodeSqliteCtor();
  const betterCtor = loadBetterSqliteCtor();

  if (configuredDriver === 'node-sqlite') {
    if (!nodeCtor) {
      throw new Error('node:sqlite is not available in this Node.js runtime');
    }
    return { driver: 'node:sqlite', ctor: nodeCtor };
  }

  if (configuredDriver === 'better-sqlite3') {
    if (!betterCtor) {
      throw new Error('better-sqlite3 is not installed');
    }
    return { driver: 'better-sqlite3', ctor: betterCtor };
  }

  if (nodeCtor) {
    return { driver: 'node:sqlite', ctor: nodeCtor };
  }

  if (betterCtor) {
    return { driver: 'better-sqlite3', ctor: betterCtor };
  }

  throw new Error('No SQLite driver available (node:sqlite or better-sqlite3)');
}

export default class Database {
  private connection: SQLiteConnection;
  readonly driver: 'node:sqlite' | 'better-sqlite3';

  constructor(path: string) {
    const resolved = resolveDatabaseDriver();
    this.driver = resolved.driver;
    if (resolved.driver === 'node:sqlite') {
      this.connection = new NodeSqliteConnection(new resolved.ctor(path));
    } else {
      this.connection = new resolved.ctor(path);
    }
  }

  prepare(sql: string): SQLiteStatement {
    return this.connection.prepare(sql) as SQLiteStatement;
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    return this.connection.pragma(sql, options);
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return this.connection.transaction(fn);
  }

  close(): void {
    this.connection.close();
  }

  get open(): boolean {
    return this.connection.open;
  }
}
