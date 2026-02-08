// Synced from `@jungjaehoon/mama-core` (2026-02-08)
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

const dbManager = require('./db-manager');

// Re-export all db-manager functions for backward compatibility
// These maintain the same interface as the original memory-store.js
module.exports = {
  // Core database functions
  initDB: dbManager.initDB, // Now async, returns Promise<connection>
  getDB: dbManager.getDB, // Sync, throws if not initialized
  getAdapter: dbManager.getAdapter, // Get database adapter (PostgreSQL or SQLite)
  closeDB: dbManager.closeDB, // Async

  // Vector search functions
  insertEmbedding: dbManager.insertEmbedding, // Async
  vectorSearch: dbManager.vectorSearch, // Async (returns null if unavailable)
  queryVectorSearch: dbManager.queryVectorSearch, // Async - Story 014.14

  // Decision functions
  insertDecisionWithEmbedding: dbManager.insertDecisionWithEmbedding, // Async
  queryDecisionGraph: dbManager.queryDecisionGraph, // Async
  querySemanticEdges: dbManager.querySemanticEdges, // Async - Graph traversal
  updateDecisionOutcome: dbManager.updateDecisionOutcome, // Async

  // Compatibility functions
  getPreparedStmt: dbManager.getPreparedStmt, // Deprecated
  getDbPath: dbManager.getDbPath, // Returns adapter name

  // Legacy exports (for backward compatibility with old code)
  traverseDecisionChain: dbManager.queryDecisionGraph, // Alias
  getSessionDecisions: async (sessionId) => {
    // Fallback implementation
    const adapter = dbManager.getAdapter();
    const stmt = adapter.prepare(`
      SELECT * FROM decisions
      WHERE session_id = ?
      ORDER BY created_at DESC
    `);
    return await stmt.all(sessionId);
  },
  incrementUsageSuccess: async (decisionId, timeSaved = 0) => {
    const adapter = dbManager.getAdapter();
    const stmt = adapter.prepare(`
      UPDATE decisions
      SET usage_success = usage_success + 1,
          time_saved = time_saved + ?,
          updated_at = ?
      WHERE id = ?
    `);
    await stmt.run(timeSaved, Date.now(), decisionId);
  },
  incrementUsageFailure: async (decisionId) => {
    const adapter = dbManager.getAdapter();
    const stmt = adapter.prepare(`
      UPDATE decisions
      SET usage_failure = usage_failure + 1,
          updated_at = ?
      WHERE id = ?
    `);
    await stmt.run(Date.now(), decisionId);
  },
  getDecisionById: async (decisionId) => {
    const adapter = dbManager.getAdapter();
    const stmt = adapter.prepare('SELECT * FROM decisions WHERE id = ?');
    return await stmt.get(decisionId);
  },

  // Path exports (for compatibility)
  DB_PATH: process.env.MAMA_DATABASE_URL ? 'PostgreSQL' : 'SQLite',
  DB_DIR: process.env.MAMA_DATABASE_URL ? 'PostgreSQL' : '~/.mama',
  LEGACY_DB_PATH: '~/.spinelift/memories.db',
  DEFAULT_DB_PATH: '~/.mama/memories.db',
};
