/**
 * Unified Statement Interface
 *
 * Wraps database-specific prepared statements to provide consistent API
 * Compatible with better-sqlite3 and pg
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
 * better-sqlite3 native statement type
 */
interface BetterSQLiteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

/**
 * pg client type
 */
interface PgClient {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
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
    // Optional: Some drivers don't require cleanup
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

  finalize(): void {
    // better-sqlite3 statements don't need explicit cleanup
  }
}

/**
 * PostgreSQL statement wrapper (pg)
 *
 * Maps pg's async query interface to synchronous-like API
 * Note: This requires careful handling in the adapter
 */
export class PostgreSQLStatement extends Statement {
  private client: PgClient;
  private sql: string;

  constructor(client: PgClient, sql: string) {
    super();
    this.client = client;
    this.sql = sql;
  }

  /**
   * Convert SQLite ? placeholders to PostgreSQL $1, $2, ...
   * @param sql - SQL with ? placeholders
   * @returns SQL with $N placeholders
   */
  static convertPlaceholders(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  // Note: PostgreSQL methods are async but the interface expects sync
  // In practice, these would need to be wrapped or the adapter would handle async
  all(..._params: unknown[]): object[] {
    // This is a simplified sync interface - actual pg usage would be async
    throw new Error('PostgreSQLStatement requires async usage - use allAsync() instead');
  }

  get(..._params: unknown[]): object | undefined {
    throw new Error('PostgreSQLStatement requires async usage - use getAsync() instead');
  }

  run(..._params: unknown[]): RunResult {
    throw new Error('PostgreSQLStatement requires async usage - use runAsync() instead');
  }

  async allAsync(...params: unknown[]): Promise<unknown[]> {
    const result = await this.client.query(this.sql, params);
    return result.rows;
  }

  async getAsync(...params: unknown[]): Promise<unknown> {
    const result = await this.client.query(this.sql, params);
    return result.rows[0];
  }

  async runAsync(...params: unknown[]): Promise<RunResult> {
    const result = await this.client.query(this.sql, params);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: (result.rows[0] as { id?: number })?.id ?? 0,
    };
  }

  finalize(): void {
    // pg statements don't need explicit cleanup
  }
}
