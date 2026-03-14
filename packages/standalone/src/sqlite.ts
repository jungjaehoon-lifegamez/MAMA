/**
 * SQLite wrapper for standalone using Node's built-in node:sqlite runtime.
 */

type NonPromise<T> = T extends Promise<unknown> ? never : T;

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

let cachedNodeSqliteCtor: NodeSqliteCtor | null | undefined;

function loadNodeSqliteCtor(): NodeSqliteCtor | null {
  if (cachedNodeSqliteCtor !== undefined) {
    return cachedNodeSqliteCtor;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  transaction<T extends (...args: never[]) => NonPromise<unknown>>(fn: T): T {
    const wrapped = ((...args: Parameters<T>) => {
      this.exec('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        if (
          ((typeof result === 'object' && result !== null) || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          this.exec('ROLLBACK');
          throw new Error('Database.transaction() callbacks must be synchronous');
        }
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

function resolveDatabaseDriver(): { driver: 'node:sqlite'; ctor: NodeSqliteCtor } {
  const configuredDriver = process.env.MAMA_SQLITE_DRIVER;
  const nodeCtor = loadNodeSqliteCtor();

  if (!nodeCtor) {
    throw new Error('node:sqlite is not available in this Node.js runtime. Use Node 22.13+.');
  }

  const normalizedDriver =
    configuredDriver === 'node-sqlite' || configuredDriver === 'node:sqlite'
      ? 'node:sqlite'
      : (configuredDriver ?? 'node:sqlite');
  if (normalizedDriver !== 'node:sqlite' && normalizedDriver !== 'auto') {
    throw new Error(
      `Unsupported SQLite driver "${configuredDriver}". MAMA OS now requires node:sqlite.`
    );
  }

  return { driver: 'node:sqlite', ctor: nodeCtor };
}

export default class Database {
  private connection: NodeSqliteConnection;
  readonly driver: 'node:sqlite';

  constructor(path: string) {
    const resolved = resolveDatabaseDriver();
    this.driver = resolved.driver;
    this.connection = new NodeSqliteConnection(new resolved.ctor(path));
  }

  prepare(sql: string): SQLiteStatement {
    return this.connection.prepare(sql);
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    return this.connection.pragma(sql, options);
  }

  transaction<T extends (...args: never[]) => NonPromise<unknown>>(fn: T): T {
    return this.connection.transaction(fn);
  }

  close(): void {
    this.connection.close();
  }

  get open(): boolean {
    return this.connection.open;
  }
}
