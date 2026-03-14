/**
 * Node SQLite statement wrapper
 *
 * Wraps node:sqlite StatementSync to provide the existing Statement API.
 */

import { Statement, type RunResult } from './statement.js';

interface NodeSQLiteStatementLike {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

export class NodeSQLiteStatement extends Statement {
  private stmt: NodeSQLiteStatementLike;

  constructor(stmt: NodeSQLiteStatementLike) {
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
