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
 * @version 2.1 (Plugin - SQLite-only)
 * @date 2026-02-01
 * @source-of-truth packages/mama-core/src/db-manager.js (mama-core)
 */

import path from 'path';
import { info, warn, error as logError } from './debug-logger.js';
import { logComplete, logSearching } from './progress-indicator.js';
import { createAdapter } from './db-adapter/index.js';
import type { PreparedStatement } from './db-adapter/statement.js';

// Re-export PreparedStatement for consumers
export type { PreparedStatement };

// Type definitions
// Note: This local interface differs from base-adapter.ts abstract class.
// The double cast at initialization bridges the type gap between the abstract
// class (which uses Statement) and this interface (which uses PreparedStatement).
export interface DatabaseAdapter {
  connect: () => unknown;
  disconnect: () => void;
  runMigrations: (dir: string) => void;
  prepare: (sql: string) => PreparedStatement;
  transaction: <T>(fn: () => T) => T;
  insertEmbedding: (rowid: number, embedding: Float32Array | number[]) => void;
  vectorSearch: (
    embedding: Float32Array | number[],
    limit: number
  ) => Promise<VectorSearchResult[] | null>;
  vectorSearchEnabled: boolean;
  getDbPath?: () => string;
  dbPath?: string;
  constructor: { name: string };
}

export interface VectorSearchResult {
  rowid: number;
  similarity?: number;
  distance?: number;
}

export interface DecisionRecord {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  outcome?: string | null;
  failure_reason?: string | null;
  limitation?: string | null;
  confidence?: number;
  supersedes?: string | null;
  superseded_by?: string | null;
  refined_from?: string | string[] | null;
  created_at: number;
  updated_at?: number;
  edges?: unknown[];
}

export interface OutcomeData {
  outcome?: string | null;
  failure_reason?: string | null;
  limitation?: string | null;
  duration_days?: number | null;
  confidence?: number | null;
}

export interface VectorSearchParams {
  query: string;
  limit?: number;
  threshold?: number;
  timeWindow?: number;
}

export interface SemanticEdges {
  refines: unknown[];
  refined_by: unknown[];
  contradicts: unknown[];
  contradicted_by: unknown[];
  builds_on: unknown[];
  built_on_by: unknown[];
  debates: unknown[];
  debated_by: unknown[];
  synthesizes: unknown[];
  synthesized_by: unknown[];
}

// Database adapter instance (singleton)
let dbAdapter: DatabaseAdapter | null = null;
let dbConnection: unknown = null;
let isInitialized = false;
let initializingPromise: Promise<unknown> | null = null; // Single-flight guard for concurrent callers

// Migration directory (moved to src/db/migrations for M1.2)
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

/**
 * Initialize SQLite database adapter and connect
 *
 * Lazy initialization: Only connects when first accessed
 * Creates database file at ~/.claude/mama-memory.db by default
 *
 * Single-flight guard: Concurrent callers await the same promise
 * to prevent multiple adapters/migrations running simultaneously.
 *
 * @returns SQLite database connection
 */
export async function initDB(): Promise<unknown> {
  // Already initialized - return immediately
  if (isInitialized) {
    return dbConnection;
  }

  // Single-flight guard: If initialization is in progress, wait for it
  if (initializingPromise) {
    return initializingPromise;
  }

  // Start initialization and store promise for concurrent callers
  initializingPromise = (async () => {
    try {
      logSearching('Initializing database...');

      // Create SQLite adapter
      dbAdapter = createAdapter() as unknown as DatabaseAdapter;

      // Connect to database
      dbConnection = await dbAdapter.connect();

      // Run migrations (includes 012-create-checkpoints-table.sql)
      await dbAdapter.runMigrations(MIGRATIONS_DIR);

      isInitialized = true;

      info(`[db-manager] Database initialized (${dbAdapter.constructor.name})`);
      logComplete('Database ready');

      return dbConnection;
    } catch (error) {
      // Clear state on failure so retry is possible
      initializingPromise = null;
      dbAdapter = null;
      dbConnection = null;
      isInitialized = false;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize database: ${message}`);
    }
  })();

  return initializingPromise;
}

/**
 * Get database connection (singleton pattern)
 *
 * Returns better-sqlite3 Database instance
 *
 * Note: Synchronous for backward compatibility with memory-store.js
 * Will throw if database not initialized
 *
 * @returns SQLite database connection
 */
export function getDB(): unknown {
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
 * @returns Adapter instance
 */
export function getAdapter(): DatabaseAdapter {
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
export async function closeDB(): Promise<void> {
  if (dbAdapter) {
    await dbAdapter.disconnect();
    dbAdapter = null;
    dbConnection = null;
    isInitialized = false;
    initializingPromise = null; // Clear to allow re-initialization
    info('[db-manager] Database connection closed');
  }
}

/**
 * Insert embedding into vector search table
 *
 * Uses sqlite-vec for vector similarity search
 * Gracefully degrades if sqlite-vec is not available
 *
 * @param decisionRowid - SQLite rowid
 * @param embedding - 384-dim embedding vector
 */
export async function insertEmbedding(
  decisionRowid: number,
  embedding: Float32Array | number[]
): Promise<void> {
  const adapter = getAdapter();

  try {
    adapter.insertEmbedding(decisionRowid, embedding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Graceful degradation: Log warning but don't fail
    logError(`[db-manager] Failed to insert embedding (vector search unavailable): ${message}`);
  }
}

/**
 * Perform vector similarity search
 *
 * Returns empty array if vector search not available (no keyword fallback)
 *
 * @param queryEmbedding - Query embedding (384-dim)
 * @param limit - Max results to return (default: 5)
 * @param threshold - Minimum similarity threshold (default: 0.7)
 * @returns Array of decisions with similarity scores, or empty array
 */
export async function vectorSearch(
  queryEmbedding: Float32Array | number[],
  limit = 5,
  threshold = 0.7
): Promise<DecisionRecord[]> {
  const adapter = getAdapter();

  try {
    // SQLite adapter returns null if sqlite-vec not available
    const results = await adapter.vectorSearch(queryEmbedding, limit * 3);

    if (!results || results.length === 0) {
      return []; // No keyword fallback - fast fail
    }

    const stmt = adapter.prepare(`SELECT * FROM decisions WHERE rowid = ?`);
    const decisions: (DecisionRecord & { similarity: number; distance: number })[] = [];

    for (const row of results) {
      const decision = stmt.get(row.rowid) as DecisionRecord | undefined;

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
    const message = error instanceof Error ? error.message : String(error);
    logError(`[db-manager] Vector search failed: ${message}`);
    return []; // No keyword fallback - fast fail
  }
}

/**
 * Decision input for storage
 */
export interface DecisionInput {
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

/**
 * Insert decision with embedding
 *
 * Combined operation: Insert decision + Generate embedding + Insert embedding
 * SQLite-only implementation
 *
 * @param decision - Decision object
 * @returns Decision ID
 */
export async function insertDecisionWithEmbedding(decision: DecisionInput): Promise<string> {
  const adapter = getAdapter();
  const { generateEnhancedEmbedding } = await import('./embeddings.js');

  try {
    // Generate embedding BEFORE transaction (required for SQLite's sync transaction)
    // Note: Redact topic for privacy - only log length
    info(
      `[db-manager] Generating embedding for decision (topic length: ${decision.topic?.length || 0})`
    );
    let embedding: Float32Array | null = null;
    try {
      embedding = await generateEnhancedEmbedding({
        topic: decision.topic,
        decision: decision.decision,
        reasoning: decision.reasoning || undefined,
        outcome: decision.outcome || undefined,
        confidence: decision.confidence,
      });
      info(`[db-manager] Embedding generated: ${embedding ? embedding.length : 'null'} dimensions`);
    } catch (embGenErr) {
      // Non-fatal: save decision without embedding (e.g. ONNX model unavailable on CI)
      const message = embGenErr instanceof Error ? embGenErr.message : String(embGenErr);
      logError(`[db-manager] ⚠️ Embedding generation failed, saving without vector: ${message}`);
    }

    // SQLite: Synchronous transaction including embedding
    adapter.transaction(() => {
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
        // IMPORTANT: All timestamps are stored in milliseconds (Date.now()).
        // The schema DEFAULT uses unixepoch() (seconds) but is never used
        // since all inserts go through this function which always provides ms.
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
      if (adapter.vectorSearchEnabled && embedding) {
        try {
          info(`[db-manager] Inserting embedding for rowid: ${rowid}`);
          adapter.insertEmbedding(rowid, embedding);
          info(`[db-manager] ✅ Embedding inserted successfully`);
        } catch (embErr) {
          const message = embErr instanceof Error ? embErr.message : String(embErr);
          // Log but don't fail transaction if embedding fails
          logError(`[db-manager] ❌ Embedding insert failed: ${message}`);
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to insert decision with embedding: ${message}`);
  }
}

/**
 * Query decision graph for topic
 *
 * Recursive CTE to traverse supersedes chain
 * SQLite implementation using WITH RECURSIVE
 *
 * @param topic - Decision topic to query
 * @returns Array of decisions (ordered by recency)
 */
export async function queryDecisionGraph(topic: string): Promise<DecisionRecord[]> {
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

    let decisions = stmt.all(topic) as DecisionRecord[];

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

      decisions = stmt.all(topicKeyword) as DecisionRecord[];
    }

    // Join with decision_edges to include relationships
    // Prepare statement once outside loop for performance
    const edgesStmt = adapter.prepare(`
      SELECT * FROM decision_edges
      WHERE from_id = ?
        AND (approved_by_user = 1 OR approved_by_user IS NULL)
    `);
    for (const decision of decisions) {
      decision.edges = edgesStmt.all(decision.id);

      // Parse refined_from JSON if exists
      if (decision.refined_from) {
        try {
          decision.refined_from =
            typeof decision.refined_from === 'string'
              ? JSON.parse(decision.refined_from)
              : decision.refined_from;
        } catch {
          decision.refined_from = [];
        }
      }
    }

    return decisions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Decision graph query failed: ${message}`);
  }
}

/**
 * Query semantic edges for a list of decisions
 *
 * Returns both outgoing (from_id) and incoming (to_id) edges
 * for refines and contradicts relationships
 *
 * @param decisionIds - Decision IDs to query edges for
 * @returns Categorized edges
 */
export async function querySemanticEdges(decisionIds: string[]): Promise<SemanticEdges> {
  const adapter = getAdapter();

  if (!decisionIds || decisionIds.length === 0) {
    return {
      refines: [],
      refined_by: [],
      contradicts: [],
      contradicted_by: [],
      // Story 2.1: Extended edge types
      builds_on: [],
      built_on_by: [],
      debates: [],
      debated_by: [],
      synthesizes: [],
      synthesized_by: [],
    };
  }

  try {
    // Build placeholders for IN clause
    const placeholders = decisionIds.map(() => '?').join(',');

    // Story 2.1: Include new edge types in query
    const edgeTypes = ['refines', 'contradicts', 'builds_on', 'debates', 'synthesizes'];
    const edgeTypePlaceholders = edgeTypes.map(() => '?').join(',');

    // Query outgoing edges (from_id = decision)
    const outgoingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.to_id = d.id
      WHERE e.from_id IN (${placeholders})
        AND e.relationship IN (${edgeTypePlaceholders})
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const outgoingEdges = outgoingStmt.all(...decisionIds, ...edgeTypes) as Array<{
      relationship: string;
    }>;

    // Query incoming edges (to_id = decision)
    const incomingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.from_id = d.id
      WHERE e.to_id IN (${placeholders})
        AND e.relationship IN (${edgeTypePlaceholders})
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const incomingEdges = incomingStmt.all(...decisionIds, ...edgeTypes) as Array<{
      relationship: string;
    }>;

    // Categorize edges (original + v1.3 extended)
    const refines = outgoingEdges.filter((e) => e.relationship === 'refines');
    const refined_by = incomingEdges.filter((e) => e.relationship === 'refines');
    const contradicts = outgoingEdges.filter((e) => e.relationship === 'contradicts');
    const contradicted_by = incomingEdges.filter((e) => e.relationship === 'contradicts');
    // Story 2.1: New edge type categories
    const builds_on = outgoingEdges.filter((e) => e.relationship === 'builds_on');
    const built_on_by = incomingEdges.filter((e) => e.relationship === 'builds_on');
    const debates = outgoingEdges.filter((e) => e.relationship === 'debates');
    const debated_by = incomingEdges.filter((e) => e.relationship === 'debates');
    const synthesizes = outgoingEdges.filter((e) => e.relationship === 'synthesizes');
    const synthesized_by = incomingEdges.filter((e) => e.relationship === 'synthesizes');

    return {
      refines,
      refined_by,
      contradicts,
      contradicted_by,
      builds_on,
      built_on_by,
      debates,
      debated_by,
      synthesizes,
      synthesized_by,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Semantic edges query failed: ${message}`);
  }
}

/**
 * Query vector search with time window and threshold
 *
 * Story 014.14: AC #1 - Vector Search for Related Decisions
 *
 * @param params - Search parameters
 * @returns Results with similarity scores and decision data
 */
export async function queryVectorSearch(params: VectorSearchParams): Promise<DecisionRecord[]> {
  const { query, limit = 10, threshold = 0.75, timeWindow = 90 * 24 * 60 * 60 * 1000 } = params;

  const adapter = getAdapter();
  const { generateEmbedding } = await import('./embeddings.js');

  try {
    // Generate embedding for query
    const embedding = await generateEmbedding(query);

    const cutoffTime = Date.now() - timeWindow;
    const candidates = await adapter.vectorSearch(embedding, limit * 5);

    if (!candidates || candidates.length === 0) {
      return [];
    }

    const stmt = adapter.prepare(`SELECT * FROM decisions WHERE rowid = ?`);
    const results: (DecisionRecord & { similarity: number; distance: number })[] = [];

    for (const candidate of candidates) {
      const decision = stmt.get(candidate.rowid) as DecisionRecord | undefined;
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
    const message = error instanceof Error ? error.message : String(error);
    logError(`[db-manager] queryVectorSearch failed: ${message}`);
    return []; // Return empty array on error (graceful degradation)
  }
}

/**
 * Update decision outcome
 *
 * @param decisionId - Decision ID
 * @param outcomeData - Outcome data
 */
export async function updateDecisionOutcome(
  decisionId: string,
  outcomeData: OutcomeData
): Promise<void> {
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

    stmt.run(
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update decision outcome: ${message}`);
  }
}

/**
 * Get prepared statement
 *
 * For backward compatibility with memory-store.js
 * Returns a compatibility shim that proxies to adapter.prepare()
 *
 * @param sql - SQL statement
 * @returns Statement-like object with run/get/all methods
 */
export function getPreparedStmt(sql: string): PreparedStatement {
  if (!dbAdapter) {
    warn('[db-manager] getPreparedStmt() called before initialization');
    // Return no-op object for feature detection (won't throw)
    return {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => null,
      all: () => [],
    };
  }

  // Proxy to adapter.prepare() for actual usage
  try {
    return dbAdapter.prepare(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`[db-manager] getPreparedStmt() failed: ${message}`);
    // Return no-op object on error (graceful degradation)
    return {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => null,
      all: () => [],
    };
  }
}

/**
 * Get database file path
 *
 * @returns Actual database path or 'Not initialized'
 */
export function getDbPath(): string {
  if (!dbAdapter) {
    return 'Not initialized';
  }
  // Use adapter's getDbPath method if available, fallback to description
  if (typeof dbAdapter.getDbPath === 'function') {
    return dbAdapter.getDbPath();
  }
  // Fallback: try to get path from adapter properties
  if (dbAdapter.dbPath) {
    return dbAdapter.dbPath;
  }
  return `${dbAdapter.constructor.name} (path unavailable)`;
}

// Note: Removed auto-registered SIGINT/SIGTERM handlers that called process.exit(0)
// This was causing issues with host cleanup in parent processes.
// If graceful shutdown is needed, the host application should handle closeDB().
