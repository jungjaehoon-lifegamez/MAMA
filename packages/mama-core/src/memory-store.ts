/**
 * MAMA Memory Store - Compatibility Wrapper
 *
 * This file now serves as a compatibility layer that re-exports db-manager functions.
 * The actual database logic has been moved to db-manager.js which supports both
 * SQLite (local development) and PostgreSQL (Railway production).
 *
 * Migration Note:
 * - Old: memory-store.js directly used better-sqlite3 + sqlite-vss
 * - New: memory-store.js → db-manager.js → db-adapter (SQLite or PostgreSQL)
 *
 * All MAMA modules can continue to require('memory-store') without changes.
 *
 * @module memory-store
 * @version 2.0
 * @date 2025-11-17
 */

import * as dbManager from './db-manager.js';
import type { PreparedStatement, VectorSearchResult } from './db-manager.js';

// Re-export for consumers
export type { PreparedStatement };

// Type for database adapter (minimal interface for this module's needs)
export interface DatabaseAdapter {
  prepare: (sql: string) => PreparedStatement;
  vectorSearchEnabled?: boolean;
  insertEmbedding?: (rowid: number, embedding: Float32Array | number[]) => void;
  vectorSearch?: (
    embedding: Float32Array | number[],
    limit: number
  ) => Promise<VectorSearchResult[] | null>;
  transaction?: <T>(fn: () => T) => T;
}

// Type for decision with embedding
export interface DecisionForStorage {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  outcome?: string | null;
  failure_reason?: string | null;
  limitation?: string | null;
  user_involvement?: string | null;
  session_id?: string | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  refined_from?: string[] | null;
  confidence?: number;
  created_at?: number;
  updated_at?: number;
  needs_validation?: number;
  validation_attempts?: number;
  last_validated_at?: number | null;
  usage_count?: number;
  trust_context?: string | null;
  usage_success?: number;
  usage_failure?: number;
  time_saved?: number;
  evidence?: string | null;
  alternatives?: string | null;
  risks?: string | null;
}

// Type for outcome data
export interface OutcomeData {
  outcome?: string | null;
  failure_reason?: string | null;
  limitation?: string | null;
  duration_days?: number | null;
  confidence?: number | null;
}

// Type for vector search params
export interface VectorSearchParams {
  query: string;
  limit?: number;
  threshold?: number;
  timeWindow?: number;
}

// Re-export all db-manager functions for backward compatibility
// These maintain the same interface as the original memory-store.js
export const initDB = dbManager.initDB;
export const getDB = dbManager.getDB;
export const getAdapter = dbManager.getAdapter;
export const closeDB = dbManager.closeDB;
export const insertEmbedding = dbManager.insertEmbedding;
export const vectorSearch = dbManager.vectorSearch;
export const queryVectorSearch = dbManager.queryVectorSearch;
export const insertDecisionWithEmbedding = dbManager.insertDecisionWithEmbedding;
export const queryDecisionGraph = dbManager.queryDecisionGraph;
export const querySemanticEdges = dbManager.querySemanticEdges;
export const updateDecisionOutcome = dbManager.updateDecisionOutcome;
export const getPreparedStmt = dbManager.getPreparedStmt;
export const getDbPath = dbManager.getDbPath;

// Legacy exports (for backward compatibility with old code)
export const traverseDecisionChain = dbManager.queryDecisionGraph; // Alias

/**
 * Get decisions for a specific session
 */
export async function getSessionDecisions(sessionId: string): Promise<unknown[]> {
  const adapter = dbManager.getAdapter() as DatabaseAdapter;
  const stmt = adapter.prepare(`
    SELECT * FROM decisions
    WHERE session_id = ?
    ORDER BY created_at DESC
  `);
  return stmt.all(sessionId);
}

/**
 * Increment usage success counter
 */
export async function incrementUsageSuccess(decisionId: string, timeSaved = 0): Promise<void> {
  const adapter = dbManager.getAdapter() as DatabaseAdapter;
  const stmt = adapter.prepare(`
    UPDATE decisions
    SET usage_success = usage_success + 1,
        time_saved = time_saved + ?,
        updated_at = ?
    WHERE id = ?
  `);
  stmt.run(timeSaved, Date.now(), decisionId);
}

/**
 * Increment usage failure counter
 */
export async function incrementUsageFailure(decisionId: string): Promise<void> {
  const adapter = dbManager.getAdapter() as DatabaseAdapter;
  const stmt = adapter.prepare(`
    UPDATE decisions
    SET usage_failure = usage_failure + 1,
        updated_at = ?
    WHERE id = ?
  `);
  stmt.run(Date.now(), decisionId);
}

/**
 * Get decision by ID
 */
export async function getDecisionById(decisionId: string): Promise<unknown> {
  const adapter = dbManager.getAdapter() as DatabaseAdapter;
  const stmt = adapter.prepare('SELECT * FROM decisions WHERE id = ?');
  return stmt.get(decisionId);
}

// Path exports (labels for display/logging, not actual filesystem paths)
// Note: Actual paths are managed by sqlite-adapter.ts (~/.claude/mama-memory.db)
export const DB_PATH = process.env.MAMA_DATABASE_URL ? 'PostgreSQL' : 'SQLite';
export const DB_DIR = process.env.MAMA_DATABASE_URL ? 'PostgreSQL' : '~/.mama';
export const LEGACY_DB_PATH = '~/.spinelift/memories.db';
export const DEFAULT_DB_PATH = '~/.mama/memories.db';
