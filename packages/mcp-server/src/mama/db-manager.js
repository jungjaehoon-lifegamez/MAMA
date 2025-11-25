/**
 * MAMA Database Manager (SQLite-only)
 *
 * SQLite-exclusive database interface for MAMA Plugin.
 * Uses better-sqlite3 + sqlite-vec for local storage.
 *
 * PostgreSQL support is only available in the legacy mcp-server repository.
 *
 * Features:
 * - WAL mode for better concurrency
 * - synchronous=NORMAL for performance
 * - Automatic migration management
 * - Vector similarity search (when sqlite-vec available)
 *
 * @module db-manager
 * @version 2.0 (Plugin - SQLite-only)
 * @date 2025-11-20
 */

const { info, warn, error: logError } = require('./debug-logger');
const { createAdapter } = require('./db-adapter');
const path = require('path');

// Database adapter instance (singleton)
let dbAdapter = null;
let dbConnection = null;
let isInitialized = false;

// Migration directory (moved to src/db/migrations for M1.2)
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

/**
 * Initialize SQLite database adapter and connect
 *
 * Lazy initialization: Only connects when first accessed
 * Creates database file at ~/.claude/mama-memory.db by default
 *
 * @returns {Promise<Object>} SQLite database connection
 */
async function initDB() {
  if (isInitialized) {
    return dbConnection;
  }

  try {
    // Create SQLite adapter
    dbAdapter = createAdapter();

    // Connect to database
    dbConnection = await dbAdapter.connect();

    // Run migrations
    await dbAdapter.runMigrations(MIGRATIONS_DIR);

    // Create checkpoints table (New Feature: Session Continuity)
    dbAdapter
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        open_files TEXT, -- JSON array
        next_steps TEXT,
        status TEXT DEFAULT 'active' -- 'active', 'archived'
      )
    `
      )
      .run();

    isInitialized = true;

    info(`[db-manager] Database initialized (${dbAdapter.constructor.name})`);

    return dbConnection;
  } catch (error) {
    throw new Error(`Failed to initialize database: ${error.message}`);
  }
}

/**
 * Get database connection (singleton pattern)
 *
 * Returns better-sqlite3 Database instance
 *
 * Note: Synchronous for backward compatibility with memory-store.js
 * Will throw if database not initialized
 *
 * @returns {Object} SQLite database connection
 */
function getDB() {
  if (!dbConnection) {
    throw new Error('Database not initialized. Call await initDB() first.');
  }
  return dbConnection;
}

/**
 * Get database adapter instance
 *
 * Used for advanced operations (vectorSearch, insertEmbedding, etc.)
 *
 * @returns {DatabaseAdapter} Adapter instance
 */
function getAdapter() {
  if (!dbAdapter) {
    throw new Error('Database adapter not initialized. Call await initDB() first.');
  }
  return dbAdapter;
}

/**
 * Close database connection
 *
 * Call this on process exit
 */
async function closeDB() {
  if (dbAdapter) {
    await dbAdapter.disconnect();
    dbAdapter = null;
    dbConnection = null;
    isInitialized = false;
    info('[db-manager] Database connection closed');
  }
}

/**
 * Insert embedding into vector search table
 *
 * Uses sqlite-vec for vector similarity search
 * Gracefully degrades if sqlite-vec is not available
 *
 * @param {number} decisionRowid - SQLite rowid
 * @param {Float32Array|Array<number>} embedding - 384-dim embedding vector
 * @returns {Promise<void>}
 */
async function insertEmbedding(decisionRowid, embedding) {
  const adapter = getAdapter();

  try {
    await adapter.insertEmbedding(decisionRowid, embedding);
  } catch (error) {
    // Graceful degradation: Log warning but don't fail
    logError(
      `[db-manager] Failed to insert embedding (vector search unavailable): ${error.message}`
    );
  }
}

/**
 * Perform vector similarity search
 *
 * Returns empty array if vector search not available (no keyword fallback)
 *
 * @param {Float32Array|Array<number>} queryEmbedding - Query embedding (384-dim)
 * @param {number} limit - Max results to return (default: 5)
 * @param {number} threshold - Minimum similarity threshold (default: 0.7)
 * @returns {Promise<Array<Object>>} Array of decisions with similarity scores, or empty array
 */
async function vectorSearch(queryEmbedding, limit = 5, threshold = 0.7) {
  const adapter = getAdapter();

  try {
    // SQLite adapter returns null if sqlite-vec not available
    const results = await adapter.vectorSearch(queryEmbedding, limit * 3);

    if (!results || results.length === 0) {
      return []; // No keyword fallback - fast fail
    }

    const stmt = adapter.prepare(`SELECT * FROM decisions WHERE rowid = ?`);
    const decisions = [];

    for (const row of results) {
      const decision = stmt.get(row.rowid);

      if (!decision) {
        continue;
      }

      const similarity = row.similarity ?? Math.max(0, 1.0 - (row.distance ?? 1));
      const distance = row.distance ?? Math.max(0, 1.0 - similarity);

      if (similarity >= threshold) {
        decisions.push({
          ...decision,
          distance,
          similarity,
        });
      }

      if (decisions.length >= limit) {
        break;
      }
    }

    return decisions;
  } catch (error) {
    logError(`[db-manager] Vector search failed: ${error.message}`);
    return []; // No keyword fallback - fast fail
  }
}

/**
 * Insert decision with embedding
 *
 * Combined operation: Insert decision + Generate embedding + Insert embedding
 * SQLite-only implementation
 *
 * @param {Object} decision - Decision object
 * @returns {Promise<string>} Decision ID
 */
async function insertDecisionWithEmbedding(decision) {
  const adapter = getAdapter();
  const { generateEnhancedEmbedding } = require('./embeddings');

  try {
    // Generate embedding BEFORE transaction (required for SQLite's sync transaction)
    info(`[db-manager] Generating embedding for decision: ${decision.topic}`);
    const embedding = await generateEnhancedEmbedding(decision);
    info(`[db-manager] Embedding generated: ${embedding ? embedding.length : 'null'} dimensions`);

    // SQLite: Synchronous transaction including embedding
    // eslint-disable-next-line no-unused-vars
    const decisionRowid = adapter.transaction(() => {
      // Prepare INSERT statement
      const stmt = adapter.prepare(`
        INSERT INTO decisions (
          id, topic, decision, reasoning,
          outcome, failure_reason, limitation,
          user_involvement, session_id,
          supersedes, superseded_by, refined_from,
          confidence, created_at, updated_at,
          needs_validation, validation_attempts, last_validated_at, usage_count,
          trust_context, usage_success, usage_failure, time_saved,
          evidence, alternatives, risks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertResult = stmt.run(
        decision.id,
        decision.topic,
        decision.decision,
        decision.reasoning || null,
        decision.outcome || null,
        decision.failure_reason || null,
        decision.limitation || null,
        decision.user_involvement || null,
        decision.session_id || null,
        decision.supersedes || null,
        decision.superseded_by || null,
        decision.refined_from ? JSON.stringify(decision.refined_from) : null,
        decision.confidence !== undefined ? decision.confidence : 0.5,
        decision.created_at || Date.now(),
        decision.updated_at || Date.now(),
        decision.needs_validation !== undefined ? decision.needs_validation : 0,
        decision.validation_attempts || 0,
        decision.last_validated_at || null,
        decision.usage_count || 0,
        decision.trust_context || null,
        decision.usage_success || 0,
        decision.usage_failure || 0,
        decision.time_saved || 0,
        decision.evidence || null,
        decision.alternatives || null,
        decision.risks || null
      );

      const rowid = Number(insertResult.lastInsertRowid);

      // Insert embedding in same transaction to ensure rowid matching
      info(`[db-manager] Vector search enabled: ${adapter.vectorSearchEnabled}`);
      if (adapter.vectorSearchEnabled) {
        try {
          info(`[db-manager] Inserting embedding for rowid: ${rowid}`);
          adapter.insertEmbedding(rowid, embedding);
          info(`[db-manager] ✅ Embedding inserted successfully`);
        } catch (embErr) {
          // Log but don't fail transaction if embedding fails
          logError(`[db-manager] ❌ Embedding insert failed: ${embErr.message}`);
        }
      } else {
        info(`[db-manager] ⚠️  Vector search disabled, skipping embedding`);
      }

      return rowid;
    });

    if (process.env.MAMA_DEBUG) {
      info(`[db-manager] Decision stored: ${decision.id}`);
    }

    return decision.id;
  } catch (error) {
    throw new Error(`Failed to insert decision with embedding: ${error.message}`);
  }
}

/**
 * Query decision graph for topic
 *
 * Recursive CTE to traverse supersedes chain
 * SQLite implementation using WITH RECURSIVE
 *
 * @param {string} topic - Decision topic to query
 * @returns {Promise<Array<Object>>} Array of decisions (ordered by recency)
 */
async function queryDecisionGraph(topic) {
  const adapter = getAdapter();

  try {
    // Story 014.14 Fix: Prioritize exact topic match over fuzzy matching
    // First try exact match, then fallback to fuzzy if no results

    // Try exact match first
    let stmt = adapter.prepare(`
      WITH RECURSIVE decision_chain AS (
        -- Base case: Get current decision (not superseded)
        SELECT * FROM decisions
        WHERE topic = ? AND superseded_by IS NULL

        UNION ALL

        -- Recursive case: Get previous decisions
        SELECT d.* FROM decisions d
        JOIN decision_chain dc ON d.id = dc.supersedes
      )
      SELECT * FROM decision_chain
      ORDER BY created_at DESC
    `);

    let decisions = await stmt.all(topic);

    // If no exact match, try fuzzy matching as fallback
    if (decisions.length === 0) {
      const topicKeyword = topic.split('_')[0];

      stmt = adapter.prepare(`
        WITH RECURSIVE decision_chain AS (
          -- Base case: Get current decision (not superseded)
          SELECT * FROM decisions
          WHERE topic LIKE ? || '%' AND superseded_by IS NULL

          UNION ALL

          -- Recursive case: Get previous decisions
          SELECT d.* FROM decisions d
          JOIN decision_chain dc ON d.id = dc.supersedes
        )
        SELECT * FROM decision_chain
        ORDER BY created_at DESC
      `);

      decisions = await stmt.all(topicKeyword);
    }

    // Join with decision_edges to include relationships
    for (const decision of decisions) {
      const edgesStmt = adapter.prepare(`
        SELECT * FROM decision_edges
        WHERE from_id = ?
          AND (approved_by_user = 1 OR approved_by_user IS NULL)
      `);
      decision.edges = await edgesStmt.all(decision.id);

      // Parse refined_from JSON if exists
      if (decision.refined_from) {
        try {
          decision.refined_from = JSON.parse(decision.refined_from);
        } catch (e) {
          decision.refined_from = [];
        }
      }
    }

    return decisions;
  } catch (error) {
    throw new Error(`Decision graph query failed: ${error.message}`);
  }
}

/**
 * Query semantic edges for a list of decisions
 *
 * Returns both outgoing (from_id) and incoming (to_id) edges
 * for refines and contradicts relationships
 *
 * @param {Array<string>} decisionIds - Decision IDs to query edges for
 * @returns {Promise<Object>} Categorized edges { refines, refined_by, contradicts, contradicted_by }
 */
async function querySemanticEdges(decisionIds) {
  const adapter = getAdapter();

  if (!decisionIds || decisionIds.length === 0) {
    return { refines: [], refined_by: [], contradicts: [], contradicted_by: [] };
  }

  try {
    // Build placeholders for IN clause
    const placeholders = decisionIds.map(() => '?').join(',');

    // Query outgoing edges (from_id = decision)
    const outgoingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.to_id = d.id
      WHERE e.from_id IN (${placeholders})
        AND e.relationship IN ('refines', 'contradicts')
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const outgoingEdges = await outgoingStmt.all(...decisionIds);

    // Query incoming edges (to_id = decision)
    const incomingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.from_id = d.id
      WHERE e.to_id IN (${placeholders})
        AND e.relationship IN ('refines', 'contradicts')
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const incomingEdges = await incomingStmt.all(...decisionIds);

    // Categorize edges
    const refines = outgoingEdges.filter((e) => e.relationship === 'refines');
    const refined_by = incomingEdges.filter((e) => e.relationship === 'refines');
    const contradicts = outgoingEdges.filter((e) => e.relationship === 'contradicts');
    const contradicted_by = incomingEdges.filter((e) => e.relationship === 'contradicts');

    return {
      refines,
      refined_by,
      contradicts,
      contradicted_by,
    };
  } catch (error) {
    throw new Error(`Semantic edges query failed: ${error.message}`);
  }
}

/**
 * Query vector search with time window and threshold
 *
 * Story 014.14: AC #1 - Vector Search for Related Decisions
 *
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query text
 * @param {number} params.limit - Max results (default: 10)
 * @param {number} params.threshold - Minimum cosine similarity (0.0-1.0, default: 0.75)
 * @param {number} params.timeWindow - Time window in ms (optional, default: 90 days)
 * @returns {Promise<Array>} Results with similarity scores and decision data
 */
async function queryVectorSearch({
  query,
  limit = 10,
  threshold = 0.75,
  timeWindow = 90 * 24 * 60 * 60 * 1000,
}) {
  const adapter = getAdapter();
  const { generateEmbedding } = require('./embeddings');

  try {
    // Generate embedding for query
    const embedding = await generateEmbedding(query);

    const cutoffTime = Date.now() - timeWindow;
    const candidates = await adapter.vectorSearch(embedding, limit * 5);

    if (!candidates || candidates.length === 0) {
      return [];
    }

    const stmt = adapter.prepare(`SELECT * FROM decisions WHERE rowid = ?`);
    const results = [];

    for (const candidate of candidates) {
      const decision = stmt.get(candidate.rowid);
      if (!decision) {
        continue;
      }

      if (decision.created_at < cutoffTime) {
        continue;
      }

      const similarity = candidate.similarity ?? Math.max(0, 1 - (candidate.distance ?? 1));
      const distance = candidate.distance ?? Math.max(0, 1 - similarity);

      if (similarity < threshold) {
        continue;
      }

      results.push({
        ...decision,
        similarity,
        distance,
      });

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  } catch (error) {
    logError(`[db-manager] queryVectorSearch failed: ${error.message}`);
    return []; // Return empty array on error (graceful degradation)
  }
}

/**
 * Update decision outcome
 *
 * @param {string} decisionId - Decision ID
 * @param {Object} outcomeData - Outcome data
 * @returns {Promise<void>}
 */
async function updateDecisionOutcome(decisionId, outcomeData) {
  const adapter = getAdapter();

  try {
    const stmt = adapter.prepare(`
      UPDATE decisions
      SET
        outcome = ?,
        failure_reason = ?,
        limitation = ?,
        duration_days = ?,
        confidence = COALESCE(?, confidence),
        updated_at = ?
      WHERE id = ?
    `);

    await stmt.run(
      outcomeData.outcome || null,
      outcomeData.failure_reason || null,
      outcomeData.limitation || null,
      outcomeData.duration_days || null,
      outcomeData.confidence !== undefined ? outcomeData.confidence : null,
      Date.now(),
      decisionId
    );

    info(`[db-manager] Decision outcome updated: ${decisionId} → ${outcomeData.outcome}`);
  } catch (error) {
    throw new Error(`Failed to update decision outcome: ${error.message}`);
  }
}

/**
 * Get prepared statement
 *
 * For backward compatibility with memory-store.js
 * Deprecated: Use adapter.prepare() directly
 *
 * @param {string} name - Statement name (ignored)
 * @returns {Object} Dummy statement object
 */
function getPreparedStmt(_name) {
  warn('[db-manager] getPreparedStmt() is deprecated. Use adapter.prepare() directly.');
  return {
    run: () => {
      throw new Error('getPreparedStmt() is deprecated');
    },
  };
}

// Export API (same interface as memory-store.js, but async where needed)
module.exports = {
  initDB, // Async
  getDB, // Sync (throws if not initialized)
  getAdapter, // Sync (throws if not initialized)
  closeDB, // Async
  insertEmbedding, // Async
  vectorSearch, // Async
  queryVectorSearch, // Async - Story 014.14
  querySemanticEdges, // Async - Graph traversal enhancement
  insertDecisionWithEmbedding, // Async
  queryDecisionGraph, // Async
  updateDecisionOutcome, // Async
  getPreparedStmt, // Deprecated
  // Legacy exports for backward compatibility
  getDbPath: () => (dbAdapter ? dbAdapter.constructor.name : 'Not initialized'),
};

// Graceful shutdown
process.on('SIGINT', async () => {
  await closeDB();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closeDB();
  process.exit(0);
});
