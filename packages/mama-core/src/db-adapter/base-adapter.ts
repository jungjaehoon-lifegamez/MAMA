/**
 * Base Database Adapter Interface
 * All adapters must implement these methods
 */

import type { Statement, RunResult } from './statement.js';

export type { Statement, RunResult };

export interface VectorSearchResult {
  rowid: number;
  similarity?: number;
  distance?: number;
}

export abstract class DatabaseAdapter {
  /**
   * Connect to database
   * @returns Database connection
   */
  abstract connect(): unknown;

  /**
   * Disconnect from database
   */
  abstract disconnect(): void;

  /**
   * Check if connected
   * @returns Connection status
   */
  abstract isConnected(): boolean;

  /**
   * Prepare a SQL statement
   * @param sql - SQL query
   * @returns Prepared statement
   */
  abstract prepare(sql: string): Statement;

  /**
   * Execute raw SQL
   * @param sql - SQL to execute
   */
  abstract exec(sql: string): void;

  /**
   * Execute function in transaction
   * @param fn - Function to execute
   * @returns Function return value
   */
  abstract transaction<T>(fn: () => T): T;

  /**
   * Vector similarity search
   * @param embedding - Query embedding (384-dim)
   * @param limit - Max results
   * @returns Search results with distance
   */
  abstract vectorSearch(
    embedding: Float32Array | number[],
    limit: number
  ): VectorSearchResult[] | null;

  /**
   * Insert vector embedding
   * @param rowid - Decision rowid
   * @param embedding - Embedding vector
   */
  abstract insertEmbedding(rowid: number, embedding: Float32Array | number[]): RunResult | null;

  /**
   * Get last inserted row ID
   * @returns Last rowid
   */
  abstract getLastInsertRowid(): number;

  /**
   * Run migrations
   * @param migrationsDir - Path to migrations directory
   */
  abstract runMigrations(migrationsDir: string): void;

  /**
   * Check if vector search is enabled
   */
  abstract get vectorSearchEnabled(): boolean;

  /**
   * Get database path
   */
  abstract getDbPath(): string;
}
