/**
 * SQLite Database Adapter using node:sqlite
 *
 * Keeps the existing DatabaseAdapter surface while avoiding external native addon installation.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { DatabaseAdapter, type VectorSearchResult, type RunResult } from './base-adapter.js';
import { NodeSQLiteStatement } from './node-sqlite-statement.js';
import { type Statement } from './statement.js';
import { info, warn, error as logError } from '../debug-logger.js';
import { cosineSimilarity } from '../embeddings.js';

const LEGACY_DB_PATH = path.join(os.homedir(), '.spinelift', 'memories.db');
const DEFAULT_DB_PATH = path.join(os.homedir(), '.claude', 'mama-memory.db');
const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SQLiteAdapterConfig {
  dbPath?: string;
}

interface NodeSQLiteDatabaseLike {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): NodeSQLiteStatementLike;
}

interface NodeSQLiteStatementLike {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}

type NodeSQLiteDatabaseCtor = new (path: string) => NodeSQLiteDatabaseLike;

// Prefer better-sqlite3 (includes FTS5) over node:sqlite (lacks FTS5)
let BetterSQLite3: NodeSQLiteDatabaseCtor | null = null;
let DatabaseSync: NodeSQLiteDatabaseCtor | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs3 = require('better-sqlite3') as
    | NodeSQLiteDatabaseCtor
    | { default: NodeSQLiteDatabaseCtor };
  BetterSQLite3 = 'default' in bs3 ? bs3.default : bs3;
} catch {
  BetterSQLite3 = null;
}

if (!BetterSQLite3) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: NodeSQLiteDatabaseCtor;
    });
  } catch {
    DatabaseSync = null;
  }
}

class NodeSQLiteConnection {
  private db: NodeSQLiteDatabaseLike;
  private connected = true;
  private isBetterSQLite3: boolean;

  constructor(db: NodeSQLiteDatabaseLike) {
    this.db = db;
    // better-sqlite3 databases have a native .pragma() method
    this.isBetterSQLite3 = typeof (db as unknown as Record<string, unknown>).pragma === 'function';
  }

  prepare(sql: string): NodeSQLiteStatementLike {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    const query = sql.trim().replace(/^PRAGMA\s+/i, '');

    if (this.isBetterSQLite3) {
      // better-sqlite3 has a native pragma method that handles both read and write pragmas
      return (this.db as unknown as Record<string, (...args: unknown[]) => unknown>).pragma(
        query,
        options
      );
    }

    // node:sqlite fallback: use prepare()
    const stmt = this.db.prepare(`PRAGMA ${query}`);
    if (options?.simple) {
      const row = stmt.get() as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      return Object.values(row)[0];
    }
    return stmt.all();
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

export class NodeSQLiteAdapter extends DatabaseAdapter {
  private config: SQLiteAdapterConfig;
  private db: NodeSQLiteConnection | null = null;
  private _vectorSearchEnabled = true;
  private vectorCache: Map<number, Float32Array> = new Map();
  private topicCache: Map<number, string> = new Map();
  // Effective status (status, falling back to outcome) per decision rowid. Used as a
  // search-time optimization only - recallMemory's post-filter stays the authority
  // (this cache can lag a status UPDATE until the next reloadVectorCache).
  private statusCache: Map<number, string> = new Map();
  private decisionsHasStatusColumns = false;
  private decisionsColumnInfoChecked = false;

  constructor(config: SQLiteAdapterConfig = {}) {
    super();
    this.config = config;
  }

  get vectorSearchEnabled(): boolean {
    return this._vectorSearchEnabled;
  }

  getDbPath(): string {
    const envPath = process.env.MAMA_DB_PATH || process.env.MAMA_DATABASE_PATH;
    const configPath = this.config.dbPath;

    let expandedEnvPath = envPath;
    if (envPath) {
      expandedEnvPath = envPath.replace(/\$\{HOME\}/g, os.homedir()).replace(/^~/, os.homedir());
    }

    const targetPath = configPath || expandedEnvPath || DEFAULT_DB_PATH;

    if (!configPath && !envPath && fs.existsSync(LEGACY_DB_PATH)) {
      info(
        '[node-sqlite-adapter] Found legacy database at ~/.spinelift/memories.db, using it for backward compatibility'
      );
      return LEGACY_DB_PATH;
    }

    return targetPath;
  }

  connect(): NodeSQLiteConnection {
    if (this.db) {
      return this.db;
    }

    const Driver = BetterSQLite3 || DatabaseSync;
    if (!Driver) {
      throw new Error(
        'No SQLite driver available. Install better-sqlite3 or use Node 22.13+ (node:sqlite).'
      );
    }

    const driverName = BetterSQLite3 ? 'better-sqlite3' : 'node:sqlite';

    const dbPath = this.getDbPath();
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      info(`[sqlite-adapter] Created database directory: ${dbDir}`);
    }

    const database = new Driver(dbPath);
    this.db = new NodeSQLiteConnection(database);
    info(`[sqlite-adapter] Opened database at: ${dbPath} (driver: ${driverName})`);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');

    info('[sqlite-adapter] Vector search: pure TS cosine similarity (no native extensions)');

    this.loadVectorCache();

    return this.db;
  }

  reloadVectorCache(): void {
    this.loadVectorCache();
  }

  // Re-read one decision's effective status into the cache. MUST be called after
  // any status transition that can move a row OUT of an excluded state (e.g.
  // promoteMemoryStatus staging->active): the vectorSearch pre-filter drops
  // excluded rowids before the api post-filter ever sees them, so a stale
  // excluded entry would make an active row unrecallable until restart.
  refreshDecisionStatusCache(rowid: number): void {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    if (!this.decisionsColumnInfoChecked) {
      this.refreshDecisionColumnInfo();
    }
    const cacheSelect = this.decisionsHasStatusColumns
      ? 'SELECT topic, status, outcome FROM decisions WHERE rowid = ?'
      : 'SELECT topic, NULL AS status, NULL AS outcome FROM decisions WHERE rowid = ?';
    const row = this.prepare(cacheSelect).get(rowid) as
      | { topic: string; status: string | null; outcome: string | null }
      | undefined;
    if (!row) {
      this.statusCache.delete(rowid);
      this.topicCache.delete(rowid);
      return;
    }
    this.topicCache.set(rowid, row.topic);
    const effectiveStatus = row.status || row.outcome;
    if (effectiveStatus) {
      this.statusCache.set(rowid, effectiveStatus);
    } else {
      this.statusCache.delete(rowid);
    }
  }

  private refreshDecisionColumnInfo(): Set<string> {
    if (!this.db) return new Set();
    const decisionCols = new Set(
      (this.db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    this.decisionsHasStatusColumns = decisionCols.has('status') && decisionCols.has('outcome');
    // Only latch "checked" once the decisions table actually exists - introspecting
    // a not-yet-migrated DB must not stop later calls from re-checking.
    this.decisionsColumnInfoChecked = decisionCols.size > 0;
    return decisionCols;
  }

  private loadVectorCache(): void {
    if (!this.db) return;

    const tableCheck = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`)
      .all() as Array<{ name: string }>;

    if (tableCheck.length === 0) {
      this.vectorCache.clear();
      this.topicCache.clear();
      this.statusCache.clear();
      return;
    }

    const start = Date.now();
    const rows = this.db.prepare('SELECT rowid, embedding FROM embeddings').all() as Array<{
      rowid: number;
      embedding: Uint8Array;
    }>;

    const CACHE_WARN_THRESHOLD = 100_000;
    this.vectorCache.clear();
    for (const row of rows) {
      const vec = bytesToVector(row.embedding);
      if (vec) {
        this.vectorCache.set(row.rowid, vec);
      }
    }

    // Load topic + effective-status caches for scoped/filtered vector search.
    // Legacy partial schemas may lack status/outcome (they are added by later
    // migrations, and loadVectorCache also runs at connect time, before
    // runMigrations) - introspect columns so prepare() cannot crash on them.
    // A missing column just leaves statusCache empty; the api-layer post-filter
    // remains the authority.
    this.topicCache.clear();
    this.statusCache.clear();
    const decisionCols = this.refreshDecisionColumnInfo();
    const statusSelect = decisionCols.has('status') ? 'status' : 'NULL AS status';
    const outcomeSelect = decisionCols.has('outcome') ? 'outcome' : 'NULL AS outcome';
    const topicRows = this.db
      .prepare(`SELECT rowid, topic, ${statusSelect}, ${outcomeSelect} FROM decisions`)
      .all() as Array<{
      rowid: number;
      topic: string;
      status: string | null;
      outcome: string | null;
    }>;
    for (const row of topicRows) {
      this.topicCache.set(row.rowid, row.topic);
      const effectiveStatus = row.status || row.outcome;
      if (effectiveStatus) {
        this.statusCache.set(row.rowid, effectiveStatus);
      }
    }

    const count = this.vectorCache.size;
    const elapsed = Date.now() - start;
    info(`[node-sqlite-adapter] Vector cache loaded: ${count} embeddings in ${elapsed}ms`);
    if (count > CACHE_WARN_THRESHOLD) {
      warn(
        `[node-sqlite-adapter] Vector cache holds ${count} embeddings — consider LRU eviction or on-demand loading for large datasets`
      );
    }
  }

  disconnect(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      info('[node-sqlite-adapter] Disconnected from database');
    }
  }

  isConnected(): boolean {
    return this.db !== null && this.db.open;
  }

  prepare(sql: string): Statement {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    return new NodeSQLiteStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    if (!this.isConnected() || !this.db) {
      throw new Error('Database not connected');
    }
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    this.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      if (
        ((typeof result === 'object' && result !== null) || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        throw new Error('DatabaseAdapter.transaction() callbacks must be synchronous');
      }
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // Preserve the original transaction failure when rollback also fails.
      }
      throw error;
    }
  }

  vectorSearch(
    embedding: Float32Array | number[],
    limit = 5,
    topicPrefix?: string,
    excludeStatuses?: readonly string[]
  ): VectorSearchResult[] | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const queryVector =
      embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);

    const effectiveLimit = Math.max(limit, 1);
    const bestMatches: VectorSearchResult[] = [];
    let minScore = -Infinity;
    const excluded =
      excludeStatuses && excludeStatuses.length > 0 ? new Set(excludeStatuses) : null;

    for (const [rowid, candidate] of this.vectorCache) {
      if (candidate.length !== queryVector.length) continue;

      // Pre-filter by topic prefix before computing similarity
      if (topicPrefix) {
        const topic = this.topicCache.get(rowid);
        if (!topic || !topic.startsWith(topicPrefix)) continue;
      }

      // Pre-filter by effective status so superseded history does not occupy
      // top-K slots (the api-layer post-filter remains the authority)
      if (excluded) {
        const status = this.statusCache.get(rowid);
        if (status && excluded.has(status)) continue;
      }

      const similarity = cosineSimilarity(candidate, queryVector);

      if (bestMatches.length < effectiveLimit) {
        bestMatches.push({ rowid, similarity, distance: 1 - similarity });
        if (bestMatches.length === effectiveLimit) {
          bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
          minScore = bestMatches[bestMatches.length - 1].similarity ?? -Infinity;
        }
      } else if (similarity > minScore) {
        bestMatches[bestMatches.length - 1] = { rowid, similarity, distance: 1 - similarity };
        bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        minScore = bestMatches[bestMatches.length - 1].similarity ?? -Infinity;
      }
    }

    if (bestMatches.length < effectiveLimit) {
      bestMatches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    }

    return bestMatches;
  }

  insertEmbedding(rowid: number, embedding: Float32Array | number[]): RunResult | null {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const vec = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
    const buffer = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

    const stmt = this.prepare(`
      INSERT OR REPLACE INTO embeddings(rowid, embedding)
      VALUES (?, ?)
    `);

    const result = stmt.run(rowid, buffer);

    // Keep in-memory caches in sync
    this.vectorCache.set(rowid, vec);
    this.refreshDecisionStatusCache(rowid);

    return result;
  }

  getLastInsertRowid(): number {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    const result = this.prepare('SELECT last_insert_rowid() as rowid').get() as {
      rowid: number;
    };
    return result.rowid;
  }

  runMigrations(migrationsDir: string): void {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }

    const tables = this.prepare(
      `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='schema_version'
    `
    ).all() as Array<{ name: string }>;

    let currentVersion = 0;
    if (tables.length > 0) {
      const version = this.prepare('SELECT MAX(version) as version FROM schema_version').get() as
        | { version: number | null }
        | undefined;
      currentVersion = version?.version || 0;
    }

    info(`[node-sqlite-adapter] Current schema version: ${currentVersion}`);

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const versionMatch = file.match(/^(\d+)-/);
      if (!versionMatch) {
        continue;
      }

      const version = parseInt(versionMatch[1], 10);
      if (version <= currentVersion) {
        continue;
      }

      const migrationPath = path.join(migrationsDir, file);
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

      info(`[node-sqlite-adapter] Applying migration: ${file}`);

      try {
        this.exec('BEGIN TRANSACTION');
        this.exec(migrationSQL);
        this.exec('COMMIT');
        this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
        info(`[node-sqlite-adapter] Migration ${file} applied successfully`);
      } catch (err) {
        this.exec('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('duplicate column') && version === 32) {
          this.recoverMemoryProvenanceMigration032();
          info(`[node-sqlite-adapter] Migration ${file} recovered successfully`);
          continue;
        }

        if (message.includes('duplicate column') && version === 34) {
          this.recoverConnectorEventScopeMigration034();
          info(`[node-sqlite-adapter] Migration ${file} recovered successfully`);
          continue;
        }

        if (message.includes('duplicate column') && version === 39) {
          this.recoverConnectorEventOperatorSeqMigration039();
          info(`[node-sqlite-adapter] Migration ${file} recovered successfully`);
          continue;
        }

        if (message.includes('duplicate column')) {
          warn(
            `[node-sqlite-adapter] Migration ${file} skipped (duplicate column - already applied)`
          );
          this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
          continue;
        }

        if (message.includes('no such table')) {
          const hasAlterTable = migrationSQL.toUpperCase().includes('ALTER TABLE');
          if (!hasAlterTable) {
            logError(
              `[node-sqlite-adapter] Migration ${file} failed (missing required table):`,
              err
            );
            throw new Error(`Migration ${file} failed: ${message}`);
          }
          warn(
            `[node-sqlite-adapter] Migration ${file} skipped: ALTER TABLE on non-existent table (${message})`
          );
          this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
          continue;
        }

        logError(`[node-sqlite-adapter] Migration ${file} failed:`, err);
        throw new Error(`Migration ${file} failed: ${message}`);
      }
    }

    this.repairSkippedFeatureMigrations(migrationsDir);

    const embeddingsTables = this.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'`
    ).all() as Array<{ name: string }>;

    if (embeddingsTables.length === 0) {
      throw new Error(
        'Embeddings table is missing after migrations. Add the required embeddings migration.'
      );
    }

    this.migrateFromVssMemories();
  }

  private repairSkippedFeatureMigrations(migrationsDir: string): void {
    if (this.tableExists('decisions')) {
      const decisionColumns = this.tableColumns('decisions');
      const hasMissingMemoryProvenanceColumn = [
        'agent_id',
        'model_run_id',
        'envelope_hash',
        'gateway_call_id',
        'source_refs_json',
        'provenance_json',
      ].some((column) => !decisionColumns.has(column));
      const hasMissingMemoryProvenanceIndex = [
        'idx_decisions_envelope_hash',
        'idx_decisions_model_run_id',
        'idx_decisions_gateway_call_id',
        'idx_memory_events_memory_created',
      ].some((indexName) => !this.indexExists(indexName));

      if (hasMissingMemoryProvenanceColumn || hasMissingMemoryProvenanceIndex) {
        this.recoverMemoryProvenanceMigration032();
        info('[node-sqlite-adapter] Repaired skipped memory provenance migration');
      }
    }

    if (!this.tableExists('model_runs') || !this.tableExists('tool_traces')) {
      this.applyRepairMigration(
        migrationsDir,
        '033-create-model-runs-and-tool-traces.sql',
        'model run provenance'
      );
    }

    if (this.tableExists('connector_event_index')) {
      const connectorColumns = this.tableColumns('connector_event_index');
      const hasMissingConnectorScopeColumn = [
        'source_cursor',
        'tenant_id',
        'project_id',
        'memory_scope_kind',
        'memory_scope_id',
      ].some((column) => !connectorColumns.has(column));

      if (hasMissingConnectorScopeColumn) {
        this.recoverConnectorEventScopeMigration034();
        info('[node-sqlite-adapter] Repaired skipped connector event scope migration');
      }

      const connectorColumnsAfterScopeRepair = this.tableColumns('connector_event_index');
      const hasMissingOperatorSeqFeature =
        !connectorColumnsAfterScopeRepair.has('operator_ingest_seq') ||
        !this.tableExists('connector_event_index_operator_seq_cursors') ||
        !this.indexExists('idx_connector_event_index_operator_scope_seq') ||
        !this.indexExists('idx_connector_event_index_operator_cursor_order') ||
        !this.triggerExists('trg_connector_event_index_operator_ingest_seq_ai') ||
        !this.triggerExists('trg_connector_event_index_operator_ingest_seq_explicit_ai') ||
        !this.schemaVersionExists(39);

      if (hasMissingOperatorSeqFeature) {
        this.recoverConnectorEventOperatorSeqMigration039();
        info('[node-sqlite-adapter] Repaired skipped connector event operator sequence migration');
      }
    }

    if (!this.tableExists('twin_edges')) {
      this.applyRepairMigration(migrationsDir, '035-create-twin-edges.sql', 'twin edge ledger');
    }

    if (
      !this.tableExists('agent_situation_packets') ||
      !this.tableExists('agent_situation_refresh_leases')
    ) {
      this.applyRepairMigration(
        migrationsDir,
        '036-create-agent-situation-packets.sql',
        'agent situation packet cache'
      );
    }

    if (!this.tableExists('context_packets')) {
      this.applyRepairMigration(
        migrationsDir,
        '037-create-context-packets.sql',
        'context packet store'
      );
    }

    // TOMBSTONE (M6, 2026-07): the vnext_* operator tables (vnext_operator_cursors,
    // vnext_operator_commits, operator_no_updates, worker_proposals) lost their last
    // living reader/writer when the vNext parallel runtime was deleted in M4 (PR #120).
    // They are intentionally KEPT: this repair path re-creates them on any DB that
    // skipped migration 038, vnext_operator_commits holds an FK to
    // vnext_operator_cursors, and shipped migrations are append-only. Do not drop
    // them without also removing this repair block, the 040/041 repair/asserts below,
    // and the schema-contract tests that pin them.
    if (
      !this.tableExists('vnext_operator_cursors') ||
      !this.tableExists('vnext_operator_commits') ||
      !this.tableExists('operator_no_updates') ||
      !this.tableExists('worker_proposals')
    ) {
      this.applyRepairMigration(
        migrationsDir,
        '038-create-vnext-operator-contracts.sql',
        'vNext operator contracts'
      );
    }

    // TOMBSTONE (M6, 2026-07): operator_memory_commit_intents (migrations 040/041)
    // has no living reader/writer since M4 (PR #120). Kept for the same reasons as
    // the 038 family above; the fail-loud asserts below still protect personal DBs
    // that skipped or corrupted these migrations.
    if (
      !this.tableExists('operator_memory_commit_intents') ||
      !this.indexExists('idx_operator_memory_commit_intents_cursor_created')
    ) {
      this.applyRepairMigration(
        migrationsDir,
        '040-create-operator-memory-commit-intents.sql',
        'operator memory commit intents'
      );
    }
    this.assertMigration040BaseComplete();
    if (!this.hasOperatorMemoryCommitIntentClaimInvariant()) {
      this.applyRepairMigration(
        migrationsDir,
        '041-enforce-operator-memory-commit-claim-invariant.sql',
        'operator memory commit claim invariant'
      );
    }
    this.assertMigration041Complete();
  }

  private applyRepairMigration(migrationsDir: string, fileName: string, label: string): void {
    const migrationPath = path.join(migrationsDir, fileName);
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Missing repair migration ${fileName} for ${label}`);
    }

    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    info(`[node-sqlite-adapter] Repairing skipped ${label} migration: ${fileName}`);
    try {
      this.transaction(() => {
        this.exec(migrationSQL);
      });
      info(`[node-sqlite-adapter] Repair migration ${fileName} applied successfully`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Repair migration ${fileName} failed: ${message}`);
    }
  }

  private operatorMemoryCommitIntentTableSql(): string {
    const tableDefinition = this.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name = 'operator_memory_commit_intents'"
    ).get() as { sql?: string } | undefined;
    return tableDefinition?.sql ?? '';
  }

  private hasOperatorMemoryCommitIntentClaimInvariant(): boolean {
    const sql = this.operatorMemoryCommitIntentTableSql();
    return (
      sql.includes("(status = 'saving' AND claim_token IS NOT NULL)") &&
      sql.includes("(status != 'saving' AND claim_token IS NULL)")
    );
  }

  private assertMigration040BaseComplete(): void {
    if (!this.tableExists('operator_memory_commit_intents')) {
      throw new Error(
        'Migration 040 recovery failed: missing table operator_memory_commit_intents'
      );
    }

    const columns = this.tableColumns('operator_memory_commit_intents');
    for (const column of [
      'intent_id',
      'cursor_name',
      'idempotency_key',
      'expected_memory_count',
      'memory_payload_hash',
      'memory_ids_json',
      'source_refs_json',
      'status',
      'claim_token',
      'created_at_ms',
      'updated_at_ms',
    ]) {
      if (!columns.has(column)) {
        throw new Error(
          `Migration 040 recovery failed: missing operator_memory_commit_intents.${column}`
        );
      }
    }

    for (const indexName of ['idx_operator_memory_commit_intents_cursor_created']) {
      if (!this.indexExists(indexName)) {
        throw new Error(`Migration 040 recovery failed: missing index ${indexName}`);
      }
    }

    const sql = this.operatorMemoryCommitIntentTableSql();
    for (const fragment of [
      'idempotency_key TEXT NOT NULL UNIQUE',
      'expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0)',
      "memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%')",
      'memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json))',
      'source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json))',
      "status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted'))",
      'created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)',
      'updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)',
    ]) {
      if (!sql.includes(fragment)) {
        throw new Error(
          `Migration 040 recovery failed: incompatible operator_memory_commit_intents table definition missing ${fragment}`
        );
      }
    }
  }

  private assertMigration041Complete(): void {
    this.assertMigration040BaseComplete();
    if (!this.hasOperatorMemoryCommitIntentClaimInvariant()) {
      throw new Error(
        'Migration 041 recovery failed: incompatible operator_memory_commit_intents table definition missing claim invariant'
      );
    }
  }

  private recoverMemoryProvenanceMigration032(): void {
    this.transaction(() => {
      const expectedDecisionColumns = [
        'agent_id',
        'model_run_id',
        'envelope_hash',
        'gateway_call_id',
        'source_refs_json',
        'provenance_json',
      ];
      const decisionColumns = this.tableColumns('decisions');
      for (const column of expectedDecisionColumns) {
        if (!decisionColumns.has(column)) {
          this.exec(`ALTER TABLE decisions ADD COLUMN ${column} TEXT`);
          decisionColumns.add(column);
        }
      }

      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_decisions_envelope_hash
          ON decisions(envelope_hash)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_decisions_model_run_id
          ON decisions(model_run_id)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_decisions_gateway_call_id
          ON decisions(gateway_call_id)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_events_memory_created
          ON memory_events(memory_id, created_at DESC)
      `);

      this.assertMigration032Complete();
      this.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
        32,
        'Add nullable memory provenance columns'
      );
    });
  }

  private assertMigration032Complete(): void {
    const decisionColumns = this.tableColumns('decisions');
    for (const column of [
      'agent_id',
      'model_run_id',
      'envelope_hash',
      'gateway_call_id',
      'source_refs_json',
      'provenance_json',
    ]) {
      if (!decisionColumns.has(column)) {
        throw new Error(`Migration 032 recovery failed: missing decisions.${column}`);
      }
    }

    for (const indexName of [
      'idx_decisions_envelope_hash',
      'idx_decisions_model_run_id',
      'idx_decisions_gateway_call_id',
      'idx_memory_events_memory_created',
    ]) {
      if (!this.indexExists(indexName)) {
        throw new Error(`Migration 032 recovery failed: missing index ${indexName}`);
      }
    }
  }

  private recoverConnectorEventScopeMigration034(): void {
    this.transaction(() => {
      const expectedColumns = [
        'source_cursor',
        'tenant_id',
        'project_id',
        'memory_scope_kind',
        'memory_scope_id',
      ];
      const columns = this.tableColumns('connector_event_index');
      for (const column of expectedColumns) {
        if (!columns.has(column)) {
          this.exec(`ALTER TABLE connector_event_index ADD COLUMN ${column} TEXT`);
          columns.add(column);
        }
      }

      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_connector_event_scope
          ON connector_event_index(tenant_id, project_id, memory_scope_kind, memory_scope_id)
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_connector_event_source_cursor
          ON connector_event_index(source_connector, source_cursor)
      `);

      this.assertMigration034Complete();
      this.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
        34,
        'Add connector event scope columns'
      );
    });
  }

  private assertMigration034Complete(): void {
    const columns = this.tableColumns('connector_event_index');
    for (const column of [
      'source_cursor',
      'tenant_id',
      'project_id',
      'memory_scope_kind',
      'memory_scope_id',
    ]) {
      if (!columns.has(column)) {
        throw new Error(`Migration 034 recovery failed: missing connector_event_index.${column}`);
      }
    }

    for (const indexName of ['idx_connector_event_scope', 'idx_connector_event_source_cursor']) {
      if (!this.indexExists(indexName)) {
        throw new Error(`Migration 034 recovery failed: missing index ${indexName}`);
      }
    }
  }

  private recoverConnectorEventOperatorSeqMigration039(): void {
    this.transaction(() => {
      const columns = this.tableColumns('connector_event_index');
      if (!columns.has('operator_ingest_seq')) {
        this.exec(`
          ALTER TABLE connector_event_index
            ADD COLUMN operator_ingest_seq INTEGER CHECK (
              operator_ingest_seq IS NULL OR operator_ingest_seq >= 1
            )
        `);
      }

      this.exec(`
        CREATE TABLE IF NOT EXISTS connector_event_index_operator_seq_cursors (
          source_connector TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT '',
          next_seq INTEGER NOT NULL CHECK (next_seq >= 1),
          PRIMARY KEY (source_connector, channel)
        )
      `);
      this.exec(`
        WITH ranked_events AS (
          SELECT
            event_index_id,
            ROW_NUMBER() OVER (
              PARTITION BY source_connector, COALESCE(channel, '')
              ORDER BY rowid ASC
            ) AS operator_seq
          FROM connector_event_index
        )
        UPDATE connector_event_index
        SET operator_ingest_seq = (
          SELECT operator_seq
          FROM ranked_events
          WHERE ranked_events.event_index_id = connector_event_index.event_index_id
        )
        WHERE operator_ingest_seq IS NULL
      `);
      this.exec(`
        INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
          source_connector,
          channel,
          next_seq
        )
        SELECT
          source_connector,
          COALESCE(channel, ''),
          COALESCE(MAX(operator_ingest_seq), 0) + 1
        FROM connector_event_index
        GROUP BY source_connector, COALESCE(channel, '')
      `);
      this.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_event_index_operator_scope_seq
          ON connector_event_index(source_connector, COALESCE(channel, ''), operator_ingest_seq)
          WHERE operator_ingest_seq IS NOT NULL
      `);
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_connector_event_index_operator_cursor_order
          ON connector_event_index(source_connector, channel, operator_ingest_seq)
      `);
      this.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_operator_ingest_seq_ai
        AFTER INSERT ON connector_event_index
        WHEN NEW.operator_ingest_seq IS NULL
        BEGIN
          INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
            source_connector,
            channel,
            next_seq
          )
          VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1);

          UPDATE connector_event_index
          SET operator_ingest_seq = (
            SELECT next_seq
            FROM connector_event_index_operator_seq_cursors
            WHERE source_connector = NEW.source_connector
              AND channel = COALESCE(NEW.channel, '')
          )
          WHERE event_index_id = NEW.event_index_id;

          UPDATE connector_event_index_operator_seq_cursors
          SET next_seq = next_seq + 1
          WHERE source_connector = NEW.source_connector
            AND channel = COALESCE(NEW.channel, '');
        END
      `);
      this.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_operator_ingest_seq_explicit_ai
        AFTER INSERT ON connector_event_index
        WHEN NEW.operator_ingest_seq IS NOT NULL
        BEGIN
          INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
            source_connector,
            channel,
            next_seq
          )
          VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1);

          UPDATE connector_event_index_operator_seq_cursors
          SET next_seq = CASE
            WHEN next_seq <= NEW.operator_ingest_seq THEN NEW.operator_ingest_seq + 1
            ELSE next_seq
          END
          WHERE source_connector = NEW.source_connector
            AND channel = COALESCE(NEW.channel, '');
        END
      `);

      this.assertMigration039Complete();
      this.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
        39,
        'Add connector event operator ingest sequence'
      );
    });
  }

  private assertMigration039Complete(): void {
    const columns = this.tableColumns('connector_event_index');
    if (!columns.has('operator_ingest_seq')) {
      throw new Error(
        'Migration 039 recovery failed: missing connector_event_index.operator_ingest_seq'
      );
    }
    if (!this.tableExists('connector_event_index_operator_seq_cursors')) {
      throw new Error(
        'Migration 039 recovery failed: missing connector_event_index_operator_seq_cursors'
      );
    }
    for (const indexName of [
      'idx_connector_event_index_operator_scope_seq',
      'idx_connector_event_index_operator_cursor_order',
    ]) {
      if (!this.indexExists(indexName)) {
        throw new Error(`Migration 039 recovery failed: missing index ${indexName}`);
      }
    }
    for (const triggerName of [
      'trg_connector_event_index_operator_ingest_seq_ai',
      'trg_connector_event_index_operator_ingest_seq_explicit_ai',
    ]) {
      if (!this.triggerExists(triggerName)) {
        throw new Error(`Migration 039 recovery failed: missing trigger ${triggerName}`);
      }
    }
  }

  private tableColumns(tableName: string): Set<string> {
    if (!SQLITE_IDENTIFIER_PATTERN.test(tableName)) {
      throw new Error('Invalid SQLite table identifier');
    }

    const rows = this.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private tableExists(tableName: string): boolean {
    if (!SQLITE_IDENTIFIER_PATTERN.test(tableName)) {
      throw new Error('Invalid SQLite table identifier');
    }

    const row = this.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(
      tableName
    ) as { name?: string } | undefined;
    return row?.name === tableName;
  }

  private indexExists(indexName: string): boolean {
    const row = this.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(
      indexName
    ) as { name?: string } | undefined;
    return row?.name === indexName;
  }

  private triggerExists(triggerName: string): boolean {
    const row = this.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?"
    ).get(triggerName) as { name?: string } | undefined;
    return row?.name === triggerName;
  }

  private schemaVersionExists(version: number): boolean {
    if (!this.tableExists('schema_version')) {
      return false;
    }
    const row = this.prepare('SELECT version FROM schema_version WHERE version = ?').get(
      version
    ) as { version?: number } | undefined;
    return row?.version === version;
  }

  private migrateFromVssMemories(): void {
    try {
      const vssTables = this.prepare(
        `SELECT name FROM sqlite_master WHERE name='vss_memories'`
      ).all() as Array<{ name: string }>;

      if (vssTables.length === 0) {
        return;
      }

      const rows = this.prepare('SELECT rowid, embedding FROM vss_memories').all() as Array<{
        rowid: number;
        embedding: Uint8Array;
      }>;

      if (rows.length > 0) {
        const insertStmt = this.prepare(
          'INSERT OR IGNORE INTO embeddings (rowid, embedding) VALUES (?, ?)'
        );
        let migrated = 0;
        for (const row of rows) {
          const res = insertStmt.run(row.rowid, Buffer.from(row.embedding));
          if (res.changes > 0) {
            migrated++;
          }
        }
        info(
          `[node-sqlite-adapter] Migrated ${migrated} embeddings from vss_memories to embeddings`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(
        `[node-sqlite-adapter] Could not migrate from vss_memories (expected if sqlite-vec not installed): ${message}`
      );
    }
  }
}

export default NodeSQLiteAdapter;

function bytesToVector(buffer: Uint8Array | Buffer | null): Float32Array | null {
  if (!buffer || buffer.byteLength % 4 !== 0) {
    return null;
  }

  try {
    const typedBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const arrayBuffer = typedBuffer.buffer.slice(
      typedBuffer.byteOffset,
      typedBuffer.byteOffset + typedBuffer.byteLength
    );
    return new Float32Array(arrayBuffer);
  } catch {
    return null;
  }
}
