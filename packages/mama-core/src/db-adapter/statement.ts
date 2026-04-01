/**
 * Unified Statement Interface
 *
 * Wraps better-sqlite3 prepared statements to provide consistent API.
 *
 * @module statement
 */

/**
 * Run result from statement execution
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Prepared statement interface
 * Common interface used across all database modules
 */
export interface PreparedStatement {
  run: (...args: unknown[]) => RunResult;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

/**
 * better-sqlite3 native statement type
 */
interface BetterSQLiteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

/**
 * Base statement interface
 * All statement wrappers must implement these methods
 */
export abstract class Statement {
  /**
   * Execute statement and return all rows
   * @param params - Query parameters
   * @returns All matching rows
   */
  abstract all(...params: unknown[]): object[];

  /**
   * Execute statement and return first row
   * @param params - Query parameters
   * @returns First matching row or undefined
   */
  abstract get(...params: unknown[]): object | undefined;

  /**
   * Execute statement without returning rows
   * @param params - Query parameters
   * @returns Execution info (changes, lastInsertRowid)
   */
  abstract run(...params: unknown[]): RunResult;

  /**
   * Release statement resources
   */
  finalize(): void {
    // better-sqlite3 statements don't need explicit cleanup
  }
}

/**
 * SQLite statement wrapper (better-sqlite3)
 */
export class SQLiteStatement extends Statement {
  private stmt: BetterSQLiteStatement;

  constructor(stmt: BetterSQLiteStatement) {
    super();
    this.stmt = stmt;
  }

  all(...params: unknown[]): object[] {
    return this.stmt.all(...params) as object[];
  }

  get(...params: unknown[]): object | undefined {
    return this.stmt.get(...params) as object | undefined;
  }

  run(...params: unknown[]): RunResult {
    return this.stmt.run(...params);
  }
}
