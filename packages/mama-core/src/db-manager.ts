/**
 * MAMA Database Manager (SQLite-only)
 *
 * SQLite-exclusive database interface for MAMA Plugin.
 * Uses better-sqlite3 for local storage.
 *
 * PostgreSQL support is only available in the legacy mcp-server repository.
 *
 * Features:
 * - WAL mode for better concurrency
 * - synchronous=NORMAL for performance
 * - Automatic migration management
 * - Vector similarity search (pure TS cosine similarity)
 *
 * @module db-manager
 * @version 2.1 (Plugin - SQLite-only)
 * @date 2026-02-01
 * @source-of-truth packages/mama-core/src/db-manager.js (mama-core)
 */

import path from 'path';
import os from 'os';
import { info } from './debug-logger.js';
import { logComplete, logSearching } from './progress-indicator.js';
import { createAdapter } from './db-adapter/index.js';
import type { PreparedStatement } from './db-adapter/statement.js';
import { EMBEDDING_PREFIX_SCHEME } from './embeddings.js';

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
  transactionImmediate?: <T>(fn: () => T) => T;
  insertEmbedding: (rowid: number, embedding: Float32Array | number[]) => void;
  vectorSearch: (
    embedding: Float32Array | number[],
    limit: number,
    topicPrefix?: string,
    excludeStatuses?: readonly string[]
  ) => Promise<VectorSearchResult[] | null> | VectorSearchResult[] | null;
  reloadVectorCache?: () => void;
  refreshDecisionStatusCache?: (rowid: number) => void;
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
  edges?: DecisionEdgeRow[];
  /** ISO 8601 date when the event actually occurred. Null if not set. */
  event_date?: string | null;
  /** Source event timestamp in milliseconds when known. Null if not set. */
  event_datetime?: number | null;
}

export interface OutcomeData {
  outcome?: string | null;
  failure_reason?: string | null;
  limitation?: string | null;
  duration_days?: number | null;
  confidence?: number | null;
}

export interface DecisionEdgeRow {
  from_id: string;
  to_id: string;
  relationship: string;
  reason?: string | null;
  weight?: number;
  created_at?: number;
  created_by?: string;
  approved_by_user?: number | null;
  decision_id?: string | null;
  evidence?: string | null;
}

export interface SemanticEdgeItem {
  from_id: string;
  to_id: string;
  relationship: string;
  reason?: string;
  topic: string;
  decision: string;
  confidence?: number;
  created_at?: string;
  approved_by_user?: number | null;
}

export interface SemanticEdges {
  refines: SemanticEdgeItem[];
  refined_by: SemanticEdgeItem[];
  contradicts: SemanticEdgeItem[];
  contradicted_by: SemanticEdgeItem[];
  builds_on: SemanticEdgeItem[];
  built_on_by: SemanticEdgeItem[];
  debates: SemanticEdgeItem[];
  debated_by: SemanticEdgeItem[];
  synthesizes: SemanticEdgeItem[];
  synthesized_by: SemanticEdgeItem[];
}

// Database adapter instance (singleton)
let dbAdapter: DatabaseAdapter | null = null;
let dbConnection: unknown = null;
let isInitialized = false;
let initializingPromise: Promise<unknown> | null = null; // Single-flight guard for concurrent callers

// Migration directory (moved to src/db/migrations for M1.2)
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const REAL_USER_DB_PATH = path.join(os.homedir(), '.claude', 'mama-memory.db');

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
function countRows(adapter: DatabaseAdapter, table: string): number {
  try {
    const row = adapter.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  } catch {
    return 0; // table may not exist on very old DBs
  }
}

/**
 * Fail loud if stored vectors predate the e5 query/passage prefix scheme.
 *
 * Migration 042 records 'e5-prefixed-v1' on a fresh DB and 'legacy-unprefixed' on a DB
 * that already held vectors at upgrade time. If the marker is not current AND legacy
 * vectors exist, cosine search would be non-discriminative, so we throw with the exact
 * re-embed command instead of silently serving degraded results. No-fallback by design.
 */
export function assertEmbeddingSchemeCurrent(adapter: DatabaseAdapter): void {
  let scheme = 'legacy-unprefixed';
  try {
    const row = adapter
      .prepare("SELECT value FROM embedding_meta WHERE key = 'embedding_prefix_scheme'")
      .get() as { value?: string } | undefined;
    if (row?.value) scheme = row.value;
  } catch {
    // embedding_meta missing (pre-042). runMigrations creates it, so this path
    // only hits if migrations did not run; fall through to the vector check.
  }

  if (scheme === EMBEDDING_PREFIX_SCHEME) return; // current

  const legacyVectors =
    countRows(adapter, 'embeddings') + countRows(adapter, 'wiki_page_embeddings');
  if (legacyVectors > 0) {
    const dbPath = resolveAdapterDbPath(adapter) ?? '<db>';
    throw new Error(
      `[embedding-guard] ${dbPath} holds ${legacyVectors} vectors written WITHOUT the e5 ` +
        `query/passage prefix (scheme='${scheme}', code requires '${EMBEDDING_PREFIX_SCHEME}'). ` +
        `Cosine search would be non-discriminative. Re-embed before starting:\n` +
        `  MAMA_DB_PATH="${dbPath}" node packages/mama-core/scripts/re-embed-migration.mjs`
    );
  }

  // No legacy vectors present: safe. Upgrade the marker so we do not re-check.
  try {
    adapter
      .prepare(
        "INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('embedding_prefix_scheme', ?)"
      )
      .run(EMBEDDING_PREFIX_SCHEME);
  } catch {
    // best-effort; if embedding_meta truly missing, nothing to guard yet
  }
}

export async function initDB(): Promise<unknown> {
  assertTestProcessIsNotUsingRealDb();

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
      assertTestProcessIsNotUsingRealDb(resolveAdapterDbPath(dbAdapter), 'adapter.getDbPath()');

      // Connect to database
      dbConnection = await dbAdapter.connect();

      // Run migrations (includes 012-create-checkpoints-table.sql)
      await dbAdapter.runMigrations(MIGRATIONS_DIR);

      // Reload vector cache after migrations (new tables/rows may now exist)
      if (typeof dbAdapter.reloadVectorCache === 'function') {
        dbAdapter.reloadVectorCache();
      }

      assertEmbeddingSchemeCurrent(dbAdapter); // fail loud on legacy vectors + new code

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

export function assertTestProcessIsNotUsingRealDb(
  effectivePath?: string,
  effectivePathSource = 'adapter'
): void {
  if (!isDatabaseBoundaryTestMode()) {
    return;
  }

  const configuredPaths = [
    { name: 'MAMA_DB_PATH', value: process.env.MAMA_DB_PATH },
    { name: 'MAMA_DATABASE_PATH', value: process.env.MAMA_DATABASE_PATH },
  ];
  if (effectivePath) {
    configuredPaths.push({ name: effectivePathSource, value: effectivePath });
  }

  for (const configuredPath of configuredPaths) {
    if (!configuredPath.value) {
      continue;
    }

    const resolvedPath = path.resolve(expandHomePath(configuredPath.value));
    if (resolvedPath === path.resolve(REAL_USER_DB_PATH)) {
      throw new Error(
        `[db-boundary] Refusing to initDB against real DB ${REAL_USER_DB_PATH} ` +
          `from a test process (${configuredPath.name}=${configuredPath.value}). ` +
          'Set MAMA_DB_PATH to a temporary path before initDB.'
      );
    }
  }
}

function resolveAdapterDbPath(adapter: DatabaseAdapter): string | undefined {
  if (typeof adapter.getDbPath === 'function') {
    return adapter.getDbPath();
  }
  return adapter.dbPath;
}

function isDatabaseBoundaryTestMode(): boolean {
  return isTestMode();
}

function expandHomePath(value: string): string {
  const home = os.homedir();
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/')) {
    return path.join(home, value.slice(2));
  }
  return value.replaceAll('${HOME}', home);
}

/**
 * Get database connection (singleton pattern)
 *
 * Returns better-sqlite3 Database instance
 *
 * Note: Synchronous because callers assume a resolved adapter, not a promise.
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

export function buildMemoryScopeId(kind: string, externalId: string): string {
  return `scope_${kind}_${Buffer.from(externalId).toString('base64url')}`;
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
 * The single write boundary for memory_scopes. Callers inside a transaction
 * pass their adapter through; the public wrapper resolves the global adapter
 * for the standalone call sites that predate the adapter-taking boundary.
 */
export function ensureMemoryScopeInAdapter(
  adapter: DatabaseAdapter,
  kind: string,
  externalId: string
): string {
  const id = buildMemoryScopeId(kind, externalId);

  adapter
    .prepare(
      `
        INSERT OR IGNORE INTO memory_scopes (id, kind, external_id)
        VALUES (?, ?, ?)
      `
    )
    .run(id, kind, externalId);

  return id;
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
  /** ISO 8601 date string for when the event actually occurred (e.g. "2023-01-15") */
  event_date?: string | null;
  /** Source event timestamp in milliseconds when known. */
  event_datetime?: number | null;
  agent_id?: string | null;
  model_run_id?: string | null;
  envelope_hash?: string | null;
  gateway_call_id?: string | null;
  source_refs_json?: string | null;
  provenance_json?: string | null;
}

/** Generate the optional vector before opening a synchronous SQLite transaction. */
export async function prepareDecisionEmbedding(
  decision: DecisionInput
): Promise<Float32Array | null> {
  if (
    decision.event_date !== null &&
    decision.event_date !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(decision.event_date) ||
      Number.isNaN(new Date(decision.event_date).getTime()))
  ) {
    throw new Error(
      `Invalid event_date: must be ISO 8601 YYYY-MM-DD (got: ${decision.event_date})`
    );
  }
  if (
    decision.event_datetime !== null &&
    decision.event_datetime !== undefined &&
    (typeof decision.event_datetime !== 'number' ||
      !Number.isFinite(decision.event_datetime) ||
      decision.event_datetime <= 0)
  ) {
    throw new Error(
      `Invalid event_datetime: must be a positive millisecond timestamp (got: ${decision.event_datetime})`
    );
  }
  const { generateEnhancedEmbedding, isForceTier3Enabled } = await import('./embeddings.js');
  if (isForceTier3Enabled()) {
    // Tier-3 is an explicit no-vector mode, not an embedder failure.
    return null;
  }
  // Failure-first: an embedder error aborts the write instead of committing a
  // decision row without its required vector.
  return await generateEnhancedEmbedding({
    topic: decision.topic,
    decision: decision.decision,
    reasoning: decision.reasoning || undefined,
    outcome: decision.outcome || undefined,
    confidence: decision.confidence,
  });
}

/** Insert one decision and its already-prepared vector inside the caller's transaction. */
export function insertPreparedDecision(
  adapter: DatabaseAdapter,
  decision: DecisionInput,
  embedding: Float32Array | null
): number {
  const stmt = adapter.prepare(`
    INSERT INTO decisions (
      id, topic, decision, reasoning, outcome, failure_reason, limitation,
      user_involvement, session_id, supersedes, superseded_by, refined_from,
      confidence, created_at, updated_at, needs_validation, validation_attempts,
      last_validated_at, usage_count, trust_context, usage_success, usage_failure,
      time_saved, evidence, alternatives, risks, event_date, event_datetime,
      agent_id, model_run_id, envelope_hash, gateway_call_id, source_refs_json, provenance_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
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
    decision.confidence ?? 0.5,
    decision.created_at || Date.now(),
    decision.updated_at || Date.now(),
    decision.needs_validation ?? 0,
    decision.validation_attempts || 0,
    decision.last_validated_at || null,
    decision.usage_count || 0,
    decision.trust_context || null,
    decision.usage_success || 0,
    decision.usage_failure || 0,
    decision.time_saved || 0,
    decision.evidence || null,
    decision.alternatives || null,
    decision.risks || null,
    decision.event_date || null,
    decision.event_datetime ?? null,
    decision.agent_id ?? null,
    decision.model_run_id ?? null,
    decision.envelope_hash ?? null,
    decision.gateway_call_id ?? null,
    decision.source_refs_json ?? null,
    decision.provenance_json ?? null
  );
  const rowid = Number(result.lastInsertRowid);
  if (embedding) {
    adapter.insertEmbedding(rowid, embedding);
  }
  return rowid;
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
  try {
    // Append-only: the outcome change is an authored judgment record; the
    // maintained decisions projection columns move in the same transaction.
    // Dynamic import avoids a module cycle with memory/write-adapters.
    const { appendOutcomeAmendment } = await import('./memory/write-adapters.js');
    await appendOutcomeAmendment(decisionId, {
      outcome: outcomeData.outcome ?? null,
      failureReason: outcomeData.failure_reason ?? null,
      limitation: outcomeData.limitation ?? null,
      confidence: outcomeData.confidence ?? null,
      durationDays: outcomeData.duration_days ?? null,
    });

    info(`[db-manager] Decision outcome updated: ${decisionId} → ${outcomeData.outcome}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update decision outcome: ${message}`);
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

/**
 * Reset database state for testing
 *
 * Resets internal state without closing connection.
 * Use this in test teardown to allow re-initialization with different DB path.
 *
 * @param options - Reset options
 * @param options.disconnect - If true, also disconnect adapter (default: true)
 */
export function resetDBState(options: { disconnect?: boolean } = {}): void {
  const { disconnect = true } = options;

  if (disconnect && dbAdapter) {
    try {
      dbAdapter.disconnect();
    } catch {
      // Ignore disconnect errors during reset
    }
  }

  dbAdapter = null;
  dbConnection = null;
  isInitialized = false;
  initializingPromise = null;
}

/**
 * Check if running in test mode
 *
 * Returns true if MAMA_TEST_MODE, VITEST, or NODE_ENV=test env vars are set
 */
export function isTestMode(): boolean {
  return Boolean(
    process.env.MAMA_TEST_MODE || process.env.VITEST || process.env.NODE_ENV === 'test'
  );
}
