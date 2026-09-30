/**
 * SQLite Database Adapter using node:sqlite
 *
 * Keeps the existing DatabaseAdapter surface while avoiding external native addon installation.
 */

import path from 'path';
import fs from 'fs';
import type { VectorSearchResult, RunResult } from './base-adapter.js';
import type { DatabaseInstance } from '../db-manager.js';
import { NodeSQLiteStatement } from './node-sqlite-statement.js';
import { type Statement } from './statement.js';
import { info, warn, error as logError } from '../debug-logger.js';
import { cosineSimilarity } from '../embedding/embedder.js';

const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Migration 071 origin invariant, kept in ONE place so the DDL the rebuild
// writes and the shape verification that admits a table cannot drift. A row is
// valid only with a model-only origin or a complete operation/actor pair.
const TOOL_TRACES_ORIGIN_CHECK = `CHECK (
    (model_run_id IS NOT NULL AND operation_id IS NULL AND actor_principal_id IS NULL)
    OR (
      operation_id IS NOT NULL AND length(trim(operation_id)) > 0
      AND actor_principal_id IS NOT NULL AND length(trim(actor_principal_id)) > 0
    )
  )`;
const TOOL_TRACES_MODEL_FK = 'FOREIGN KEY (model_run_id) REFERENCES model_runs(model_run_id)';
const WORKFLOW_KIND_MIGRATION_COLUMNS = [
  'id',
  'topic',
  'decision',
  'reasoning',
  'outcome',
  'failure_reason',
  'limitation',
  'user_involvement',
  'session_id',
  'supersedes',
  'superseded_by',
  'refined_from',
  'confidence',
  'created_at',
  'updated_at',
  'needs_validation',
  'validation_attempts',
  'last_validated_at',
  'usage_count',
  'trust_context',
  'usage_success',
  'usage_failure',
  'time_saved',
  'evidence',
  'alternatives',
  'risks',
  'event_date',
  'kind',
  'status',
  'summary',
  'is_static',
  'event_datetime',
  'agent_id',
  'model_run_id',
  'envelope_hash',
  'gateway_call_id',
  'source_refs_json',
  'provenance_json',
  'item_id',
  'record_kind',
  'payload_json',
  'applies_from',
  'applies_until',
  'duration_days',
] as const;

function normalizeSqlText(sql: string): string {
  return sql.replace(/\s+/g, '').toLowerCase();
}

/**
 * Split a CREATE TABLE body (the text between the outermost parentheses) into
 * its top-level column and table-constraint clauses. Respects nested
 * parentheses (CHECK expressions), and single/double/backtick/bracket quoted
 * identifiers and string literals. This is a targeted parser for reconstructing
 * ONE known table, not a general SQL engine.
 */
function splitCreateTableClauses(createSql: string): string[] {
  const open = createSql.indexOf('(');
  const close = createSql.lastIndexOf(')');
  if (open < 0 || close <= open) {
    return [];
  }
  const body = createSql.slice(open + 1, close);
  const clauses: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        // Doubled quote is an escaped quote, not a close (SQLite identifier/string rule).
        if (quote !== ']' && body[i + 1] === quote) {
          current += body[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      if (current.trim()) {
        clauses.push(current.trim());
      }
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    clauses.push(current.trim());
  }
  return clauses;
}

const TABLE_CONSTRAINT_KEYWORDS = new Set(['constraint', 'primary', 'unique', 'check', 'foreign']);

function clauseIsTableConstraint(clause: string): boolean {
  const firstToken = clause.trimStart().split(/[\s(]/, 1)[0].toLowerCase();
  return TABLE_CONSTRAINT_KEYWORDS.has(firstToken);
}

/**
 * Quote a decoded identifier for safe emission in SQL. Any column/table name we
 * recovered from a CREATE TABLE clause or sqlite_master (possibly containing a
 * space, an embedded double quote, or a reserved word) is re-quoted with SQLite
 * double-quote rules: wrap in double quotes and double any embedded double quote.
 * clauseColumnName strips quoting, so the INSERT/SELECT column list MUST re-quote
 * or a name like `runtime note` becomes two bare tokens and breaks the migration.
 */
function quoteSqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Column name of a column-definition clause, stripping quotes/brackets. */
function clauseColumnName(clause: string): string {
  const trimmed = clause.trimStart();
  const first = trimmed[0];
  if (first === '"' || first === '`' || first === "'") {
    let name = '';
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === first) {
        if (trimmed[i + 1] === first) {
          name += first;
          i++;
        } else {
          break;
        }
      } else {
        name += trimmed[i];
      }
    }
    return name;
  }
  if (first === '[') {
    const end = trimmed.indexOf(']');
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/[\s(]/, 1)[0];
}

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

/** One author of migrations, and where they live. */
export interface MigrationSource {
  /** Namespaces the version numbers. The core's own is `core`. */
  readonly name: string;
  readonly dir: string;
}

/** The core is one source among others; it is only first because others build on it. */
export const CORE_MIGRATION_SOURCE = 'core';

export class NodeSQLiteAdapter implements DatabaseInstance {
  private transactionDepth = 0;
  private config: SQLiteAdapterConfig;
  private db: NodeSQLiteConnection | null = null;
  private vectorCache: Map<number, Float32Array> = new Map();
  private topicCache: Map<number, string> = new Map();
  private kindCache: Map<number, string> = new Map();
  // Effective status (status, falling back to outcome) per decision rowid. Used as a
  // search-time optimization only - recallMemory's post-filter stays the authority
  // (this cache can lag a status UPDATE until the next reloadVectorCache).
  private statusCache: Map<number, string> = new Map();
  private decisionsHasStatusColumns = false;
  private decisionsColumnInfoChecked = false;

  constructor(config: SQLiteAdapterConfig = {}) {
    this.config = config;
  }

  getDbPath(): string {
    const envPath = process.env.MAMA_DB_PATH || process.env.MAMA_DATABASE_PATH;
    const configPath = this.config.dbPath;

    const targetPath = configPath || envPath;
    // The adapter used to expand `~` and `${HOME}` here, which made a shared library
    // the thing that decides what home means. Whoever set the variable knows; this
    // says so rather than guessing on their behalf.
    if (
      targetPath &&
      (targetPath === '~' || targetPath.startsWith('~/') || targetPath.includes('${HOME}'))
    ) {
      throw new Error(
        `Database path is not resolved (${targetPath}). ` +
          'Expand it where the home directory is known and pass the result.'
      );
    }
    if (!targetPath) {
      // There used to be a default here: ~/.claude/mama-memory.db. A shared core that
      // knows where one product keeps its database is not shared, and a caller who
      // forgot to say got a database it never named -- which is worse than an error,
      // because it works.
      throw new Error(
        'No database path. Pass dbPath, or set MAMA_DB_PATH before opening the database.'
      );
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
  // a status amendment back to active): the vectorSearch pre-filter drops
  // excluded rowids before the api post-filter ever sees them, so a stale
  // excluded entry would make an active row unrecallable until restart.
  refreshDecisionStatusCache(rowid: number): void {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    const decisionCols = this.refreshDecisionColumnInfo();
    const kindSelect = decisionCols.has('kind') ? 'kind' : 'NULL AS kind';
    const cacheSelect = this.decisionsHasStatusColumns
      ? `SELECT topic, ${kindSelect}, status, outcome FROM decisions WHERE rowid = ?`
      : `SELECT topic, ${kindSelect}, NULL AS status, NULL AS outcome FROM decisions WHERE rowid = ?`;
    const row = this.prepare(cacheSelect).get(rowid) as
      | { topic: string; kind: string | null; status: string | null; outcome: string | null }
      | undefined;
    if (!row) {
      this.statusCache.delete(rowid);
      this.topicCache.delete(rowid);
      this.kindCache.delete(rowid);
      return;
    }
    this.topicCache.set(rowid, row.topic);
    if (row.kind) {
      this.kindCache.set(rowid, row.kind);
    } else {
      this.kindCache.delete(rowid);
    }
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
      this.kindCache.clear();
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
    this.kindCache.clear();
    this.statusCache.clear();
    const decisionCols = this.refreshDecisionColumnInfo();
    const kindSelect = decisionCols.has('kind') ? 'kind' : 'NULL AS kind';
    const statusSelect = decisionCols.has('status') ? 'status' : 'NULL AS status';
    const outcomeSelect = decisionCols.has('outcome') ? 'outcome' : 'NULL AS outcome';
    const topicRows = this.db
      .prepare(
        `SELECT rowid, topic, ${kindSelect}, ${statusSelect}, ${outcomeSelect} FROM decisions`
      )
      .all() as Array<{
      rowid: number;
      topic: string;
      kind: string | null;
      status: string | null;
      outcome: string | null;
    }>;
    for (const row of topicRows) {
      this.topicCache.set(row.rowid, row.topic);
      if (row.kind) this.kindCache.set(row.rowid, row.kind);
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
        `[node-sqlite-adapter] Vector cache holds ${count} embeddings -- consider LRU eviction or on-demand loading for large datasets`
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
    return this.runTransaction(fn, 'deferred');
  }

  transactionImmediate<T>(fn: () => T): T {
    return this.runTransaction(fn, 'immediate');
  }

  private runTransaction<T>(fn: () => T, mode: 'deferred' | 'immediate'): T {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    const depth = this.transactionDepth;
    const vectorSnapshot = new Map(this.vectorCache);
    const topicSnapshot = new Map(this.topicCache);
    const kindSnapshot = new Map(this.kindCache);
    const statusSnapshot = new Map(this.statusCache);
    const savepoint = `mama_nested_${depth}`;
    this.exec(
      depth === 0
        ? mode === 'immediate'
          ? 'BEGIN IMMEDIATE'
          : 'BEGIN TRANSACTION'
        : `SAVEPOINT ${savepoint}`
    );
    this.transactionDepth += 1;
    try {
      const result = fn();
      if (
        ((typeof result === 'object' && result !== null) || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        throw new Error('DatabaseAdapter.transaction() callbacks must be synchronous');
      }
      this.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      this.transactionDepth = depth;
      return result;
    } catch (error) {
      this.vectorCache = vectorSnapshot;
      this.topicCache = topicSnapshot;
      this.kindCache = kindSnapshot;
      this.statusCache = statusSnapshot;
      this.transactionDepth = depth;
      let cleanupError: unknown;
      try {
        this.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
        if (depth > 0) {
          this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch (rollbackError) {
        cleanupError = rollbackError;
      }
      if (cleanupError !== undefined) {
        const failures = [error, cleanupError];
        try {
          this.disconnect();
        } catch (disconnectError) {
          failures.push(disconnectError);
          this.db = null;
        }
        throw new AggregateError(
          failures,
          'Transaction settlement and rollback cleanup both failed; adapter disconnected'
        );
      }
      throw error;
    }
  }

  vectorSearch(
    embedding: Float32Array | number[],
    limit = 5,
    topicPrefix?: string,
    excludeStatuses?: readonly string[],
    kind?: string | [string, ...string[]]
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

      // Pre-filter by memory kind so unrelated records cannot consume the top-K
      // candidate slots before the recall layer applies its requested kind.
      if (
        kind !== undefined &&
        (Array.isArray(kind)
          ? !kind.some((value) => value === this.kindCache.get(rowid))
          : this.kindCache.get(rowid) !== kind)
      )
        continue;

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

  /**
   * Run migrations from one source, or from several in order.
   *
   * A migration belongs to whoever wrote it, and its identity is (source,
   * version). One author could key on the number alone; a second cannot, because
   * the next number is already spoken for. Without this there is nowhere for a
   * package's own table to live except inside the core.
   *
   * The core's source runs first and the rest follow, so a later source can
   * reference what the core declared. A plain directory means the core's own.
   */
  /**
   * Record that one source's migration ran. Before (source, version) there was
   * one author, so the column did not exist; a database that has not reached 085
   * yet still has the old shape and is still the core's.
   */
  private stampMigration(sourceName: string, version: number): void {
    if (this.tableColumns('schema_version').has('source')) {
      this.prepare('INSERT OR IGNORE INTO schema_version (source, version) VALUES (?, ?)').run(
        sourceName,
        version
      );
      return;
    }
    this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
  }

  runMigrations(sources: string | readonly MigrationSource[]): void {
    const list: readonly MigrationSource[] =
      typeof sources === 'string' ? [{ name: CORE_MIGRATION_SOURCE, dir: sources }] : sources;
    for (const source of list) {
      this.runMigrationSource(source.dir, source.name);
    }
  }

  private runMigrationSource(migrationsDir: string, sourceName: string): void {
    if (!this.isConnected()) {
      throw new Error('Database not connected');
    }
    const isCore = sourceName === CORE_MIGRATION_SOURCE;

    const tables = this.prepare(
      `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='schema_version'
    `
    ).all() as Array<{ name: string }>;

    let currentVersion = 0;
    if (tables.length > 0) {
      // Progress is per source. A shared MAX() would let one author's numbering
      // declare another author's migrations already applied.
      const hasSource = this.tableColumns('schema_version').has('source');
      const version = (
        hasSource
          ? this.prepare('SELECT MAX(version) as version FROM schema_version WHERE source = ?').get(
              sourceName
            )
          : this.prepare('SELECT MAX(version) as version FROM schema_version').get()
      ) as { version: number | null } | undefined;
      currentVersion = version?.version || 0;
    }

    info(`[node-sqlite-adapter] Current schema version (${sourceName}): ${currentVersion}`);

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    if (
      isCore &&
      currentVersion >= 72 &&
      fs.existsSync(path.join(migrationsDir, '072-observation-versions.sql')) &&
      this.needsObservationVersionsRepair072()
    ) {
      this.recoverObservationVersionsMigration072();
    }
    if (
      isCore &&
      currentVersion >= 73 &&
      this.tableExists('registry_nodes') &&
      fs.existsSync(path.join(migrationsDir, '073-registry-corrections.sql')) &&
      this.needsRegistryCorrectionsRepair073()
    ) {
      this.recoverRegistryCorrectionsMigration073(migrationsDir);
    }
    if (
      isCore &&
      currentVersion >= 74 &&
      this.tableExists('twin_edges') &&
      fs.existsSync(path.join(migrationsDir, '074-work-graph-ref-kinds.sql')) &&
      this.needsWorkGraphRefsRepair074()
    ) {
      this.recoverWorkGraphRefsMigration074();
    }
    if (
      isCore &&
      currentVersion >= 77 &&
      this.tableExists('decisions') &&
      fs.existsSync(path.join(migrationsDir, '077-legacy-record-kind.sql')) &&
      !this.legacyRecordKindShape077()
    ) {
      this.recoverLegacyRecordKindMigration077();
    }
    if (
      isCore &&
      currentVersion >= 79 &&
      this.tableExists('twin_edges') &&
      fs.existsSync(path.join(migrationsDir, '079-twin-edge-relations.sql')) &&
      this.needsTwinEdgeRelationsRepair079()
    ) {
      this.recoverTwinEdgeRelationsMigration079();
    }

    for (const file of migrationFiles) {
      const versionMatch = file.match(/^(\d+)-/);
      if (!versionMatch) {
        continue;
      }

      const version = parseInt(versionMatch[1], 10);
      if (version <= currentVersion) {
        continue;
      }

      if (isCore && version === 98) {
        const decisionColumns = this.tableColumns('decisions');
        if (
          !this.tableExists('decisions_fts') ||
          !WORKFLOW_KIND_MIGRATION_COLUMNS.every((column) => decisionColumns.has(column))
        ) {
          warn(
            `[node-sqlite-adapter] Migration ${file} deferred: the full decisions projection is not present`
          );
          continue;
        }
        this.rebuildWorkflowMemoryKind098(migrationsDir);
        this.stampMigration(sourceName, version);
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      // Runtime MetricsStore may already own project_id/channel_id. Reconcile
      // this additive migration atomically instead of accepting a duplicate skip.
      if (isCore && version === 68) {
        if (!this.tableExists('tool_traces')) {
          // Legacy version ledgers can have skipped 033; the structural repair
          // below creates its table before reconciling 068. Do not stamp it yet.
          continue;
        }
        this.recoverToolTraceDiagnosticsMigration068();
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      // Relaxing tool_traces.model_run_id to nullable and adding the operation
      // origin CHECK needs a table rebuild that also preserves any extra runtime
      // columns/indexes a live database carries - more than the static SQL file
      // can express. Reconcile with a dynamic rebuild instead of exec'ing the SQL.
      if (isCore && version === 71) {
        if (!this.tableExists('tool_traces')) {
          // A legacy ledger may have skipped 033; the structural repair below
          // creates the table first, then this rebuild reconciles it. Do not
          // stamp 71 yet.
          continue;
        }
        this.recoverServiceOperationOriginsMigration071();
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      if (isCore && version === 72) {
        // `observation_versions` is the core's own table. This used to skip the
        // migration entirely when `connector_event_index` was absent -- back when
        // the connector index WAS the substrate -- so a consumer without the
        // connector package silently got no observations at all, and every later
        // migration touching them was swallowed as "no such table".
        if (!this.tableExists('observation_versions')) {
          this.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
          this.stampMigration(sourceName, version);
          info(`[node-sqlite-adapter] Migration ${file} applied`);
          continue;
        }
        this.recoverObservationVersionsMigration072();
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      if (isCore && version === 73) {
        this.recoverRegistryCorrectionsMigration073(migrationsDir);
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      if (isCore && version === 74) {
        if (!this.tableExists('twin_edges')) {
          continue;
        }
        this.recoverWorkGraphRefsMigration074();
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      if (isCore && version === 77) {
        this.recoverLegacyRecordKindMigration077();
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      // Extending the twin_edges relation CHECK needs the same dynamic rebuild
      // as 074 so custom columns, indexes, triggers, and FK children survive;
      // the static SQL file cannot express that. Reconcile instead of exec'ing.
      if (isCore && version === 79) {
        if (!this.tableExists('twin_edges')) {
          continue;
        }
        this.recoverTwinEdgeRelationsMigration079();
        info(`[node-sqlite-adapter] Migration ${file} reconciled successfully`);
        continue;
      }

      if (isCore && version === 92) {
        // Legacy high-version stores may carry only a skeletal decisions table.
        // An external-content FTS rebuild cannot read columns that do not exist;
        // leave this migration unstamped until the canonical table is present.
        const columns = this.tableColumns('decisions');
        if (!['topic', 'decision', 'reasoning'].every((column) => columns.has(column))) {
          warn(`[node-sqlite-adapter] Migration ${file} deferred: decisions content is incomplete`);
          continue;
        }
      }

      const migrationPath = path.join(migrationsDir, file);
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

      info(`[node-sqlite-adapter] Applying migration: ${file}`);

      try {
        this.exec('BEGIN TRANSACTION');
        this.exec(migrationSQL);
        this.exec('COMMIT');
        this.stampMigration(sourceName, version);
        info(`[node-sqlite-adapter] Migration ${file} applied successfully`);
      } catch (err) {
        this.exec('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('duplicate column') && version === 32) {
          this.recoverMemoryProvenanceMigration032();
          info(`[node-sqlite-adapter] Migration ${file} recovered successfully`);
          continue;
        }

        if (message.includes('duplicate column')) {
          warn(
            `[node-sqlite-adapter] Migration ${file} skipped (duplicate column - already applied)`
          );
          this.stampMigration(sourceName, version);
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
          this.stampMigration(sourceName, version);
          continue;
        }

        logError(`[node-sqlite-adapter] Migration ${file} failed:`, err);
        throw new Error(`Migration ${file} failed: ${message}`);
      }
    }

    if (isCore) {
      this.repairSkippedFeatureMigrations(migrationsDir);
    }

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
    this.repairRegistryIdentityStructures(migrationsDir);

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

    // Also repairs databases already stamped 68 by the former generic duplicate
    // skip, which rolled back the new columns before advancing schema_version.
    // Only enter the recovery transaction when something is actually missing --
    // a complete database must not take the write path on every runMigrations().
    if (
      fs.existsSync(path.join(migrationsDir, '068-tool-trace-diagnostics.sql')) &&
      this.needsToolTraceDiagnosticsRepair068()
    ) {
      this.recoverToolTraceDiagnosticsMigration068();
    }

    // Runs after the 068 repair so tool_traces already carries the diagnostic
    // columns. Only enters the rebuild when the operation-origin shape is
    // actually missing - a complete database must not rebuild on every open.
    if (
      fs.existsSync(path.join(migrationsDir, '071-service-operation-origins.sql')) &&
      this.tableExists('tool_traces') &&
      this.needsServiceOperationOriginsRepair071()
    ) {
      this.recoverServiceOperationOriginsMigration071();
    }

    if (
      fs.existsSync(path.join(migrationsDir, '072-observation-versions.sql')) &&
      this.needsObservationVersionsRepair072()
    ) {
      this.recoverObservationVersionsMigration072();
      info('[node-sqlite-adapter] Repaired skipped observation versions migration');
    }

    if (
      fs.existsSync(path.join(migrationsDir, '073-registry-corrections.sql')) &&
      this.needsRegistryCorrectionsRepair073()
    ) {
      this.recoverRegistryCorrectionsMigration073(migrationsDir);
      info('[node-sqlite-adapter] Repaired skipped registry corrections migration');
    }

    if (
      fs.existsSync(path.join(migrationsDir, '074-work-graph-ref-kinds.sql')) &&
      this.tableExists('twin_edges') &&
      this.needsWorkGraphRefsRepair074()
    ) {
      this.recoverWorkGraphRefsMigration074();
      info('[node-sqlite-adapter] Repaired skipped work graph ref migration');
    }

    if (!this.tableExists('twin_edges')) {
      this.applyRepairMigration(migrationsDir, '035-create-twin-edges.sql', 'twin edge ledger');
    }

    if (
      fs.existsSync(path.join(migrationsDir, '072-observation-versions.sql')) &&
      this.needsObservationVersionsRepair072()
    ) {
      this.recoverObservationVersionsMigration072();
    }
    if (
      fs.existsSync(path.join(migrationsDir, '073-registry-corrections.sql')) &&
      this.needsRegistryCorrectionsRepair073()
    ) {
      this.recoverRegistryCorrectionsMigration073(migrationsDir);
    }
    if (
      fs.existsSync(path.join(migrationsDir, '074-work-graph-ref-kinds.sql')) &&
      this.needsWorkGraphRefsRepair074()
    ) {
      this.recoverWorkGraphRefsMigration074();
    }

    // A database stamped >= 79 whose twin_edges was rebuilt from 035/074 above
    // still carries the pre-079 edge_type CHECK; extend it here so the missing
    // relation list is repaired in the same pass.
    if (
      fs.existsSync(path.join(migrationsDir, '079-twin-edge-relations.sql')) &&
      this.tableExists('twin_edges') &&
      this.needsTwinEdgeRelationsRepair079()
    ) {
      this.recoverTwinEdgeRelationsMigration079();
      info('[node-sqlite-adapter] Repaired skipped twin edge relations migration');
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

  private repairRegistryIdentityStructures(migrationsDir: string): void {
    type ColumnShape = {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    };
    const columnsMatch = (
      table: string,
      expected: Array<[string, string, number, string | null, number]>
    ): boolean => {
      if (!this.tableExists(table)) {
        return false;
      }
      const rows = this.prepare(`PRAGMA table_info("${table}")`).all() as ColumnShape[];
      return (
        rows.length === expected.length &&
        expected.every(([name, type, notnull, dflt, pk]) => {
          const row = rows.find((candidate) => candidate.name === name);
          return Boolean(
            row &&
            row.type.toUpperCase() === type &&
            row.notnull === notnull &&
            row.pk === pk &&
            row.dflt_value === dflt
          );
        })
      );
    };
    const fkMatch = (table: string, expected: Array<[string, string, string, string]>): boolean => {
      if (!this.tableExists(table)) {
        return false;
      }
      const rows = this.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
        from: string;
        table: string;
        to: string;
        on_delete: string;
      }>;
      return expected.every(([from, target, to, onDelete]) =>
        rows.some(
          (row) =>
            row.from === from &&
            row.table === target &&
            row.to === to &&
            row.on_delete.toUpperCase() === onDelete
        )
      );
    };
    const indexMatch = (name: string, columns: string[]): boolean => {
      if (!this.indexExists(name)) {
        return false;
      }
      const rows = this.prepare(`PRAGMA index_info("${name}")`).all() as Array<{
        seqno: number;
        name: string;
      }>;
      return (
        rows.length === columns.length &&
        rows.sort((a, b) => a.seqno - b.seqno).every((row, index) => row.name === columns[index])
      );
    };
    const registrySql = this.tableExists('registry_nodes')
      ? this.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registry_nodes'"
        ).get()
      : undefined;
    const aliasSql = this.tableExists('registry_aliases')
      ? String(
          (
            this.prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registry_aliases'"
            ).get() as { sql?: string } | undefined
          )?.sql ?? ''
        )
      : '';
    const scopeSql = this.tableExists('registry_scope_bindings')
      ? String(
          (
            this.prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registry_scope_bindings'"
            ).get() as { sql?: string } | undefined
          )?.sql ?? ''
        )
      : '';
    const registryMalformed =
      Boolean(registrySql) &&
      (!columnsMatch('registry_nodes', [
        ['id', 'TEXT', 0, null, 1],
        ['kind', 'TEXT', 1, null, 0],
        ['name', 'TEXT', 1, null, 0],
        ['parent_id', 'TEXT', 0, null, 0],
        ['merged_into', 'TEXT', 0, null, 0],
        ['merge_reason', 'TEXT', 0, null, 0],
        ['note', 'TEXT', 0, null, 0],
        ['created_at', 'INTEGER', 1, null, 0],
        ['updated_at', 'INTEGER', 1, null, 0],
      ]) ||
        !columnsMatch('registry_aliases', [
          ['node_id', 'TEXT', 1, null, 0],
          ['kind', 'TEXT', 1, null, 1],
          ['alias', 'TEXT', 1, null, 2],
          ['alias_display', 'TEXT', 1, null, 0],
          ['scope_kind', 'TEXT', 1, null, 3],
          ['scope_id', 'TEXT', 1, null, 4],
          ['created_at', 'INTEGER', 1, null, 0],
        ]) ||
        !columnsMatch('registry_scope_bindings', [
          ['node_id', 'TEXT', 1, null, 1],
          ['scope_kind', 'TEXT', 1, null, 2],
          ['scope_id', 'TEXT', 1, null, 3],
        ]) ||
        !fkMatch('registry_nodes', [
          ['parent_id', 'registry_nodes', 'id', 'SET NULL'],
          ['merged_into', 'registry_nodes', 'id', 'SET NULL'],
        ]) ||
        !fkMatch('registry_aliases', [['node_id', 'registry_nodes', 'id', 'CASCADE']]) ||
        !fkMatch('registry_scope_bindings', [['node_id', 'registry_nodes', 'id', 'CASCADE']]) ||
        !normalizeSqlText(String((registrySql as { sql?: string }).sql ?? '')).includes(
          normalizeSqlText("CHECK (kind IN ('item', 'person', 'client'))")
        ) ||
        !normalizeSqlText(aliasSql).includes(
          normalizeSqlText("CHECK (kind IN ('item', 'person', 'client'))")
        ) ||
        !normalizeSqlText(scopeSql).includes(
          normalizeSqlText("CHECK (scope_kind IN ('global', 'user', 'channel', 'project'))")
        ) ||
        !indexMatch('idx_registry_nodes_kind', ['kind', 'merged_into']) ||
        !indexMatch('idx_registry_nodes_parent', ['parent_id']) ||
        !indexMatch('idx_registry_aliases_node', ['node_id']) ||
        !indexMatch('idx_registry_aliases_scope', ['kind', 'alias', 'scope_kind', 'scope_id']) ||
        !indexMatch('idx_registry_scope_lookup', ['scope_kind', 'scope_id', 'node_id']));
    if (registryMalformed) {
      this.rebuildRegistry069(migrationsDir);
    }
    const registryStructureMissing =
      !this.tableExists('registry_nodes') ||
      !this.tableExists('registry_aliases') ||
      !this.tableExists('registry_scope_bindings') ||
      !this.indexExists('idx_registry_nodes_kind') ||
      !this.indexExists('idx_registry_nodes_parent') ||
      !this.indexExists('idx_registry_aliases_node') ||
      !this.indexExists('idx_registry_scope_lookup');
    if (registryStructureMissing) {
      this.applyRepairMigration(
        migrationsDir,
        '069-create-registry-nodes.sql',
        'registry nodes and aliases'
      );
    }

    if (!this.tableExists('decisions')) {
      return;
    }
    if (this.tableColumns('decisions').has('item_id')) {
      const itemColumn = (
        this.prepare('PRAGMA table_info("decisions")').all() as ColumnShape[]
      ).find((column) => column.name === 'item_id');
      if (
        !itemColumn ||
        itemColumn.type.toUpperCase() !== 'TEXT' ||
        itemColumn.notnull !== 0 ||
        itemColumn.pk !== 0 ||
        itemColumn.dflt_value !== null
      ) {
        throw new Error('Migration 070 cannot safely repair noncanonical decisions.item_id');
      }
    }
    const actorSql = this.tableExists('record_actors')
      ? this.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_actors'"
        ).get()
      : undefined;
    const actorMalformed =
      Boolean(actorSql) &&
      (!columnsMatch('record_actors', [
        ['record_id', 'TEXT', 1, null, 1],
        ['person_id', 'TEXT', 1, null, 2],
        ['role', 'TEXT', 1, null, 3],
        ['position', 'INTEGER', 1, '0', 0],
        ['created_at', 'INTEGER', 1, null, 0],
      ]) ||
        !fkMatch('record_actors', [['record_id', 'decisions', 'id', 'CASCADE']]) ||
        !indexMatch('idx_record_actors_person', ['person_id', 'record_id']));
    if (actorMalformed) {
      this.rebuildRecordActors070();
    }
    const needsRecordIdentityRepair =
      !this.tableColumns('decisions').has('item_id') ||
      !this.tableExists('record_actors') ||
      !this.indexExists('idx_decisions_item') ||
      !this.indexExists('idx_record_actors_person');
    if (!needsRecordIdentityRepair) {
      return;
    }

    this.exec('BEGIN TRANSACTION');
    try {
      if (!this.tableColumns('decisions').has('item_id')) {
        this.exec('ALTER TABLE decisions ADD COLUMN item_id TEXT');
      }
      this.exec('CREATE INDEX IF NOT EXISTS idx_decisions_item ON decisions(item_id)');
      this.exec(`CREATE TABLE IF NOT EXISTS record_actors (
        record_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL,
        role TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (record_id, person_id, role)
      )`);
      this.exec(
        'CREATE INDEX IF NOT EXISTS idx_record_actors_person ON record_actors(person_id, record_id)'
      );
      this.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
        70,
        'Record identity bindings'
      );
      this.exec('COMMIT');
      info('[node-sqlite-adapter] Repaired skipped record identity migration');
    } catch (repairError) {
      this.exec('ROLLBACK');
      throw repairError;
    }
  }

  private rebuildRegistry069(migrationsDir: string): void {
    const originalTableSql = (table: string): string =>
      String(
        (
          this.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(
            table
          ) as { sql?: string } | undefined
        )?.sql ?? ''
      );
    const extraConstraints = (table: string, canonicalFragments: string[]): string[] => {
      const clauses = splitCreateTableClauses(originalTableSql(table));
      if (clauses.length === 0) {
        throw new Error(`Migration 069 cannot parse ${table} definition`);
      }
      for (const clause of clauses.filter((candidate) => !clauseIsTableConstraint(candidate))) {
        const normalized = normalizeSqlText(clause);
        const hasInlineConstraint = ['check(', 'unique', 'collate', 'references'].some((token) =>
          normalized.includes(token)
        );
        const columnName = clauseColumnName(clause);
        const managedConstraint =
          (columnName === 'kind' && normalized.includes('check(')) ||
          (columnName === 'scope_kind' && normalized.includes('check(')) ||
          (['parent_id', 'merged_into', 'node_id'].includes(columnName) &&
            normalized.includes('references'));
        if (
          hasInlineConstraint &&
          !managedConstraint &&
          !canonicalFragments.some((fragment) => normalized.includes(normalizeSqlText(fragment)))
        ) {
          throw new Error(`Migration 069 cannot safely preserve inline constraint in ${table}`);
        }
      }
      return clauses.filter((clause) => {
        if (!clauseIsTableConstraint(clause)) {
          return false;
        }
        const normalized = normalizeSqlText(clause);
        return !canonicalFragments.some((fragment) =>
          normalized.includes(normalizeSqlText(fragment))
        );
      });
    };
    const nodeExtras = extraConstraints('registry_nodes', [
      "CHECK (kind IN ('item', 'person', 'client'))",
      'FOREIGN KEY (parent_id) REFERENCES registry_nodes(id)',
      'FOREIGN KEY (merged_into) REFERENCES registry_nodes(id)',
      'REFERENCES registry_nodes(id) ON DELETE SET NULL',
    ]);
    const aliasExtras = this.tableExists('registry_aliases')
      ? extraConstraints('registry_aliases', [
          "CHECK (kind IN ('item', 'person', 'client'))",
          'PRIMARY KEY (kind, alias, scope_kind, scope_id)',
          // The pre-scope shape, which is exactly what this rebuild exists to
          // convert. Listing only the post-migration spelling made every database
          // written before alias scoping look like it carried a constraint this
          // code does not understand, so the rebuild preserved it and emitted a
          // CREATE TABLE with two PRIMARY KEY clauses. The daemon could not open
          // its own older database.
          'PRIMARY KEY (kind, alias)',
          'FOREIGN KEY (node_id) REFERENCES registry_nodes(id)',
          'REFERENCES registry_nodes(id) ON DELETE CASCADE',
        ])
      : [];
    const scopeExtras = this.tableExists('registry_scope_bindings')
      ? extraConstraints('registry_scope_bindings', [
          "CHECK (scope_kind IN ('global', 'user', 'channel', 'project'))",
          'PRIMARY KEY (node_id, scope_kind, scope_id)',
          'FOREIGN KEY (node_id) REFERENCES registry_nodes(id)',
          'REFERENCES registry_nodes(id) ON DELETE CASCADE',
        ])
      : [];
    const nodes = this.prepare('SELECT * FROM registry_nodes').all() as Array<
      Record<string, unknown>
    >;
    const aliases = this.tableExists('registry_aliases')
      ? (this.prepare('SELECT * FROM registry_aliases').all() as Array<Record<string, unknown>>)
      : [];
    const scopes = this.tableExists('registry_scope_bindings')
      ? (this.prepare('SELECT * FROM registry_scope_bindings').all() as Array<
          Record<string, unknown>
        >)
      : [];
    const nodeIds = new Set<string>();
    for (const row of nodes) {
      if (
        typeof row.id !== 'string' ||
        !row.id ||
        !['item', 'person', 'client'].includes(String(row.kind)) ||
        typeof row.name !== 'string' ||
        !row.name.trim()
      ) {
        throw new Error('Migration 069 source row violates registry node contract');
      }
      nodeIds.add(row.id);
    }
    const aliasKeys = new Set<string>();
    for (const row of aliases) {
      const key = `${String(row.kind)}:${String(row.alias)}:${String(row.scope_kind ?? 'global')}:${String(row.scope_id ?? '*')}`;
      if (
        !nodeIds.has(String(row.node_id)) ||
        !['item', 'person', 'client'].includes(String(row.kind)) ||
        typeof row.alias !== 'string' ||
        !row.alias ||
        aliasKeys.has(key)
      ) {
        throw new Error('Migration 069 source row violates registry alias contract');
      }
      aliasKeys.add(key);
    }
    const customObjects = this.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type IN ('index', 'trigger')
         AND tbl_name IN ('registry_nodes', 'registry_aliases', 'registry_scope_bindings')
         AND sql IS NOT NULL
         AND name NOT IN (
           'idx_registry_nodes_kind', 'idx_registry_nodes_parent',
           'idx_registry_aliases_node', 'idx_registry_aliases_scope',
           'idx_registry_scope_lookup'
         )`
    ).all() as Array<{ sql: string }>;
    let migrationSQL = fs.readFileSync(
      path.join(migrationsDir, '069-create-registry-nodes.sql'),
      'utf8'
    );
    const inject = (table: string, extras: string[]): void => {
      if (extras.length === 0) {
        return;
      }
      const pattern = new RegExp(`(CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?)(\\n\\);)`);
      if (!pattern.test(migrationSQL)) {
        throw new Error(`Migration 069 cannot preserve ${table} constraints`);
      }
      migrationSQL = migrationSQL.replace(pattern, `$1,\n  ${extras.join(',\n  ')}$2`);
    };
    inject('registry_nodes', nodeExtras);
    inject('registry_aliases', aliasExtras);
    inject('registry_scope_bindings', scopeExtras);
    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      throw new Error('Migration 069 could not disable foreign_keys before rebuild');
    }
    try {
      this.transaction(() => {
        this.exec('DROP TABLE IF EXISTS registry_scope_bindings');
        this.exec('DROP TABLE IF EXISTS registry_aliases');
        this.exec('DROP TABLE registry_nodes');
        this.exec(migrationSQL);
        const insertNode = this.prepare(
          `INSERT INTO registry_nodes
         (id, kind, name, parent_id, merged_into, merge_reason, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const row of nodes) {
          insertNode.run(
            row.id,
            row.kind,
            row.name,
            row.parent_id ?? null,
            row.merged_into ?? null,
            row.merge_reason ?? null,
            row.note ?? null,
            typeof row.created_at === 'number' ? row.created_at : 0,
            typeof row.updated_at === 'number'
              ? row.updated_at
              : typeof row.created_at === 'number'
                ? row.created_at
                : 0
          );
        }
        const insertAlias = this.prepare(
          `INSERT INTO registry_aliases
         (node_id, kind, alias, alias_display, scope_kind, scope_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const row of aliases) {
          insertAlias.run(
            row.node_id,
            row.kind,
            row.alias,
            typeof row.alias_display === 'string' ? row.alias_display : row.alias,
            typeof row.scope_kind === 'string' ? row.scope_kind : 'global',
            typeof row.scope_id === 'string' ? row.scope_id : '*',
            typeof row.created_at === 'number' ? row.created_at : 0
          );
        }
        const insertScope = this.prepare(
          'INSERT INTO registry_scope_bindings (node_id, scope_kind, scope_id) VALUES (?, ?, ?)'
        );
        for (const row of scopes) {
          insertScope.run(row.node_id, row.scope_kind, row.scope_id);
        }
        for (const object of customObjects) {
          this.exec(object.sql);
        }
        const violations = this.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error('Migration 069 repair left foreign key violations');
        }
      });
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
  }

  private rebuildRecordActors070(): void {
    const originalSql = String(
      (
        this.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='record_actors'"
        ).get() as { sql?: string } | undefined
      )?.sql ?? ''
    );
    const actorExtras = splitCreateTableClauses(originalSql).filter((clause) => {
      if (!clauseIsTableConstraint(clause)) {
        return false;
      }
      const normalized = normalizeSqlText(clause);
      return ![
        'PRIMARY KEY (record_id, person_id, role)',
        'FOREIGN KEY (record_id) REFERENCES decisions(id)',
      ].some((fragment) => normalized.includes(normalizeSqlText(fragment)));
    });
    for (const clause of splitCreateTableClauses(originalSql).filter(
      (candidate) => !clauseIsTableConstraint(candidate)
    )) {
      const normalized = normalizeSqlText(clause);
      const hasInlineConstraint = ['check(', 'unique', 'collate', 'references'].some((token) =>
        normalized.includes(token)
      );
      const canonicalReference = normalized.includes(
        'record_idtextnotnullreferencesdecisions(id)ondeletecascade'
      );
      if (hasInlineConstraint && !canonicalReference) {
        throw new Error('Migration 070 cannot safely preserve inline record_actors constraint');
      }
    }
    const rows = this.prepare('SELECT * FROM record_actors').all() as Array<
      Record<string, unknown>
    >;
    const keys = new Set<string>();
    for (const row of rows) {
      const key = `${String(row.record_id)}:${String(row.person_id)}:${String(row.role)}`;
      const decision = this.prepare('SELECT 1 FROM decisions WHERE id = ?').get(row.record_id);
      if (
        !decision ||
        typeof row.person_id !== 'string' ||
        !row.person_id ||
        typeof row.role !== 'string' ||
        !row.role ||
        keys.has(key)
      ) {
        throw new Error('Migration 070 source row violates record actor contract');
      }
      keys.add(key);
    }
    const customObjects = this.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type IN ('index', 'trigger') AND tbl_name = 'record_actors'
         AND sql IS NOT NULL AND name != 'idx_record_actors_person'`
    ).all() as Array<{ sql: string }>;
    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      throw new Error('Migration 070 could not disable foreign_keys before rebuild');
    }
    try {
      this.transaction(() => {
        this.exec('DROP TABLE record_actors');
        this.exec(`CREATE TABLE record_actors (
        record_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL,
        role TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (record_id, person_id, role)
        ${actorExtras.length > 0 ? `, ${actorExtras.join(', ')}` : ''}
      )`);
        this.exec('CREATE INDEX idx_record_actors_person ON record_actors(person_id, record_id)');
        const insert = this.prepare(
          `INSERT INTO record_actors
         (record_id, person_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)`
        );
        for (const row of rows) {
          insert.run(
            row.record_id,
            row.person_id,
            row.role,
            typeof row.position === 'number' ? row.position : 0,
            typeof row.created_at === 'number' ? row.created_at : 0
          );
        }
        for (const object of customObjects) {
          this.exec(object.sql);
        }
        const violations = this.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error('Migration 070 repair left foreign key violations');
        }
      });
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
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

  private rebuildWorkflowMemoryKind098(migrationsDir: string): void {
    const migrationPath = path.join(migrationsDir, '098-workflow-memory-kind.sql');
    if (!fs.existsSync(migrationPath)) {
      throw new Error('Migration 098 workflow-kind rebuild SQL is missing');
    }
    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      throw new Error('Migration 098 could not disable foreign_keys before rebuilding decisions');
    }
    try {
      this.transaction(() => {
        this.exec(fs.readFileSync(migrationPath, 'utf8'));
      });
      const violations = this.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error('Migration 098 left foreign key violations');
      }
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
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

  private needsToolTraceDiagnosticsRepair068(): boolean {
    if (!this.tableExists('tool_traces')) {
      // The table itself is missing: let the recovery helper fail loudly.
      return true;
    }
    const columns = this.tableColumns('tool_traces');
    const hasMissingColumn = [
      'diagnostic_json',
      'evidence_json',
      'catalog_revision',
      'owner_scope',
      'project_id',
      'channel_id',
    ].some((column) => !columns.has(column));
    const hasMissingIndex = [
      'idx_tool_traces_scope_recency',
      'idx_tool_traces_channel_recency',
    ].some((indexName) => !this.indexExists(indexName));
    return hasMissingColumn || hasMissingIndex || !this.schemaVersionExists(68);
  }

  private recoverToolTraceDiagnosticsMigration068(): void {
    this.transaction(() => {
      if (!this.tableExists('tool_traces')) {
        throw new Error('Migration 068 recovery failed: missing table tool_traces');
      }
      const expectedColumns = [
        'diagnostic_json',
        'evidence_json',
        'catalog_revision',
        'owner_scope',
        'project_id',
        'channel_id',
      ];
      const columns = this.tableColumns('tool_traces');
      for (const column of expectedColumns) {
        if (!columns.has(column)) {
          this.exec(`ALTER TABLE tool_traces ADD COLUMN ${column} TEXT`);
        }
      }
      this.exec(`
        CREATE INDEX IF NOT EXISTS idx_tool_traces_scope_recency
          ON tool_traces(owner_scope, project_id, created_at DESC, trace_id DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_traces_channel_recency
          ON tool_traces(owner_scope, project_id, channel_id, created_at DESC, trace_id DESC);
      `);
      const actualColumns = this.tableColumns('tool_traces');
      for (const column of expectedColumns) {
        if (!actualColumns.has(column)) {
          throw new Error(`Migration 068 recovery failed: missing tool_traces.${column}`);
        }
      }
      for (const index of ['idx_tool_traces_scope_recency', 'idx_tool_traces_channel_recency']) {
        if (!this.indexExists(index)) {
          throw new Error(`Migration 068 recovery failed: missing index ${index}`);
        }
      }
      this.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(68);
    });
  }

  private toolTracesTableSql(): string {
    const row = this.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_traces'"
    ).get() as { sql?: string } | undefined;
    return row?.sql ?? '';
  }

  private tableSql(name: string): string {
    const row = this.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(
      name
    ) as { sql?: string } | undefined;
    if (!row?.sql) {
      throw new Error(`Missing CREATE TABLE definition for ${name}`);
    }
    return row.sql;
  }

  private storedObjectsForTable(
    table: string,
    excludedIndexes: ReadonlySet<string> = new Set()
  ): { indexes: string[]; triggers: string[] } {
    const indexes = (
      this.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL"
      ).all(table) as Array<{ name: string; sql: string }>
    )
      .filter((row) => !excludedIndexes.has(row.name))
      .map((row) => row.sql);
    const triggers = (
      this.prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ? AND sql IS NOT NULL"
      ).all(table) as Array<{ sql: string }>
    ).map((row) => row.sql);
    return { indexes, triggers };
  }

  private tablesInForeignKeyGraph(parent: string): string[] {
    const graph = new Set<string>([parent]);
    const tables = this.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const refs = this.prepare('SELECT "table" AS ref FROM pragma_foreign_key_list(?)').all(
        name
      ) as Array<{ ref?: string }>;
      if (refs.some((ref) => ref.ref === parent)) {
        graph.add(name);
      }
    }
    return [...graph];
  }

  private observationVersionsShape072(): boolean {
    if (!this.tableExists('observation_versions')) {
      return false;
    }
    const required = [
      'observation_id',
      'source',
      'source_id',
      'producer_version_id',
      'body',
      'body_location_json',
      'author',
      'source_at',
      'observed_at',
      'content_hash',
      'metadata_json',
      'scope_json',
    ];
    const columns = this.tableColumns('observation_versions');
    const clauses = splitCreateTableClauses(this.tableSql('observation_versions'));
    const columnClauses = new Map(
      clauses
        .filter((clause) => !clauseIsTableConstraint(clause))
        .map((clause) => [clauseColumnName(clause), normalizeSqlText(clause)])
    );
    const bodyXor = normalizeSqlText(
      'CHECK ((body IS NOT NULL AND body_location_json IS NULL) OR ' +
        '(body IS NULL AND body_location_json IS NOT NULL))'
    );
    const columnInfo = new Map(
      (
        this.prepare('PRAGMA table_info(observation_versions)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map((column) => [column.name, column])
    );
    // Whether any index points AT an observation is that index's own business.
    // This migration declares the evidence; it does not declare its readers.
    return (
      required.every((column) => columns.has(column)) &&
      required.every((column) => {
        const expected = ['source_at', 'observed_at'].includes(column) ? 'INTEGER' : 'TEXT';
        return columnInfo.get(column)?.type.toUpperCase() === expected;
      }) &&
      columnInfo.get('observation_id')?.pk === 1 &&
      ['source', 'source_id', 'observed_at', 'content_hash', 'metadata_json', 'scope_json'].every(
        (column) => columnInfo.get(column)?.notnull === 1
      ) &&
      columnClauses.get('source') ===
        normalizeSqlText('source TEXT NOT NULL CHECK (length(trim(source)) > 0)') &&
      columnClauses.get('source_id') ===
        normalizeSqlText('source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0)') &&
      columnClauses.get('content_hash') ===
        normalizeSqlText('content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0)') &&
      clauses.some((clause) => normalizeSqlText(clause) === bodyXor) &&
      this.indexExists('observation_source_versions') &&
      normalizeSqlText(this.indexSql('observation_source_versions')).includes(
        'onobservation_versions(source,source_id,observed_at,observation_id)'
      )
    );
  }

  private needsObservationVersionsRepair072(): boolean {
    return !this.observationVersionsShape072() || !this.schemaVersionExists(72);
  }

  private recoverObservationVersionsMigration072(): void {
    if (this.observationVersionsShape072()) {
      this.transaction(() => {
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(72, 'Immutable connector and owner observation versions');
      });
      return;
    }

    const canonical = new Map<string, string>([
      ['observation_id', 'observation_id TEXT PRIMARY KEY'],
      ['source', 'source TEXT NOT NULL CHECK (length(trim(source)) > 0)'],
      ['source_id', 'source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0)'],
      ['producer_version_id', 'producer_version_id TEXT'],
      ['body', 'body TEXT'],
      ['body_location_json', 'body_location_json TEXT'],
      ['author', 'author TEXT'],
      ['source_at', 'source_at INTEGER'],
      ['observed_at', 'observed_at INTEGER NOT NULL'],
      ['content_hash', 'content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0)'],
      ['metadata_json', 'metadata_json TEXT NOT NULL'],
      ['scope_json', 'scope_json TEXT NOT NULL'],
    ]);
    let existingNames: string[] = [];
    let columnDefs = [...canonical.values()];
    let constraints = [
      'CHECK ((body IS NOT NULL AND body_location_json IS NULL) OR ' +
        '(body IS NULL AND body_location_json IS NOT NULL))',
    ];
    const bodyXor = normalizeSqlText(constraints[0]);
    let objects = { indexes: [] as string[], triggers: [] as string[] };
    if (this.tableExists('observation_versions')) {
      const clauses = splitCreateTableClauses(this.tableSql('observation_versions'));
      if (clauses.length === 0) {
        throw new Error('Migration 072 recovery failed: unreadable observation_versions');
      }
      const columns = clauses.filter((clause) => !clauseIsTableConstraint(clause));
      existingNames = columns.map(clauseColumnName);
      const missing = [...canonical.keys()].filter((name) => !existingNames.includes(name));
      const count = (
        this.prepare('SELECT COUNT(*) AS count FROM observation_versions').get() as {
          count: number;
        }
      ).count;
      if (missing.length > 0 && count > 0) {
        throw new Error(
          `Migration 072 cannot preserve populated rows missing columns: ${missing.join(', ')}`
        );
      }
      for (const clause of columns) {
        const name = clauseColumnName(clause);
        if (!canonical.has(name)) {
          continue;
        }
        const normalized = normalizeSqlText(clause);
        const expected = normalizeSqlText(canonical.get(name) as string);
        const legacyExpected = normalizeSqlText(
          name === 'observation_id'
            ? 'observation_id TEXT PRIMARY KEY'
            : [
                  'source',
                  'source_id',
                  'observed_at',
                  'content_hash',
                  'metadata_json',
                  'scope_json',
                ].includes(name)
              ? `${name} ${['observed_at', 'source_at'].includes(name) ? 'INTEGER' : 'TEXT'} NOT NULL`
              : `${name} ${name === 'source_at' ? 'INTEGER' : 'TEXT'}`
        );
        if (
          normalized !== expected &&
          normalized !== legacyExpected &&
          /collate|generated|references|\bunique\b|\bcheck\b/i.test(clause)
        ) {
          throw new Error(`Migration 072 cannot safely preserve inline constraint on ${name}`);
        }
      }
      const extras = columns.filter((clause) => !canonical.has(clauseColumnName(clause)));
      columnDefs = [...canonical.values(), ...extras];
      const customConstraints = clauses.filter(
        (clause) =>
          clauseIsTableConstraint(clause) &&
          !(
            normalizeSqlText(clause).includes('bodyisnotnullandbody_location_jsonisnull') &&
            normalizeSqlText(clause).includes('bodyisnullandbody_location_jsonisnotnull')
          )
      );
      for (const constraint of clauses.filter(clauseIsTableConstraint)) {
        const normalizedConstraint = normalizeSqlText(constraint);
        if (
          (normalizedConstraint.includes('body') ||
            normalizedConstraint.includes('body_location_json')) &&
          normalizedConstraint !== bodyXor
        ) {
          throw new Error('Migration 072 cannot safely preserve conflicting body CHECK');
        }
      }
      constraints = [...constraints, ...customConstraints];
      objects = this.storedObjectsForTable(
        'observation_versions',
        new Set(['observation_source_versions'])
      );
    }

    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      throw new Error('Migration 072 recovery failed: could not disable foreign_keys');
    }
    try {
      this.transaction(() => {
        if (this.tableExists('observation_versions')) {
          this.exec(
            `CREATE TABLE observation_versions_072_new (\n  ${[...columnDefs, ...constraints].join(
              ',\n  '
            )}\n)`
          );
          if (existingNames.length > 0) {
            const columns = existingNames.map(quoteSqlIdentifier).join(', ');
            this.exec(
              `INSERT INTO observation_versions_072_new (${columns}) SELECT ${columns} FROM observation_versions`
            );
          }
          this.exec('DROP TABLE observation_versions');
          this.exec('ALTER TABLE observation_versions_072_new RENAME TO observation_versions');
        } else {
          this.exec(
            `CREATE TABLE observation_versions (\n  ${[...columnDefs, ...constraints].join(
              ',\n  '
            )}\n)`
          );
        }
        for (const sql of objects.indexes) {
          this.exec(sql);
        }
        this.exec(
          'CREATE INDEX observation_source_versions ON observation_versions(source, source_id, observed_at, observation_id)'
        );
        for (const sql of objects.triggers) {
          this.exec(sql);
        }
        if (!this.observationVersionsShape072()) {
          throw new Error('Migration 072 recovery failed: incomplete observation shape');
        }
        for (const table of this.tablesInForeignKeyGraph('observation_versions')) {
          if (this.prepare('SELECT 1 FROM pragma_foreign_key_check(?)').all(table).length > 0) {
            throw new Error(
              `Migration 072 recovery failed: foreign key violations after rebuild (${table})`
            );
          }
        }
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(72, 'Immutable connector and owner observation versions');
      });
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
  }

  private registryCorrectionsShape073(): boolean {
    const expected = new Map<string, string[]>([
      ['registry_identity_state', ['singleton', 'revision']],
      [
        'registry_corrections',
        [
          'command_id',
          'operation',
          'expected_revision',
          'committed_revision',
          'principal_id',
          'agent_id',
          'origin',
          'payload_json',
          'reason',
          'evidence_json',
          'scope_json',
          'receipt_json',
          'created_at',
        ],
      ],
      [
        'registry_ref_assignments',
        [
          'command_id',
          'edge_id',
          'endpoint',
          'original_kind',
          'original_id',
          'resolved_node_id',
          'committed_revision',
          'created_at',
        ],
      ],
    ]);
    if (
      !(
        [...expected].every(
          ([table, columns]) =>
            this.tableExists(table) &&
            columns.every((column) => this.tableColumns(table).has(column))
        ) &&
        this.indexExists('idx_registry_ref_assignments_current') &&
        normalizeSqlText(this.indexSql('idx_registry_ref_assignments_current')).includes(
          'onregistry_ref_assignments(edge_id,endpoint,committed_revisiondesc)'
        )
      )
    ) {
      return false;
    }
    const stateSql = normalizeSqlText(this.tableSql('registry_identity_state'));
    const correctionsSql = normalizeSqlText(this.tableSql('registry_corrections'));
    const assignmentsSql = normalizeSqlText(this.tableSql('registry_ref_assignments'));
    const correctionClauses = splitCreateTableClauses(this.tableSql('registry_corrections'));
    const aggregateAuthorityCheck = normalizeSqlText(
      `CHECK (
        (origin = 'trusted' AND principal_id IS NOT NULL AND length(trim(principal_id)) > 0
          AND agent_id IS NOT NULL AND length(trim(agent_id)) > 0)
        OR (origin = 'legacy_unattributed' AND principal_id IS NULL AND agent_id IS NULL)
      )`
    );
    const stateRows = this.prepare(
      'SELECT singleton, revision FROM registry_identity_state ORDER BY singleton'
    ).all() as Array<{ singleton: number; revision: number }>;
    const correctionInfo = new Map(
      (
        this.prepare('PRAGMA table_info(registry_corrections)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map((column) => [column.name, column])
    );
    const assignmentInfo = new Map(
      (
        this.prepare('PRAGMA table_info(registry_ref_assignments)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map((column) => [column.name, column])
    );
    const assignmentFks = this.prepare(
      'SELECT "from" AS from_col, "table" AS target, "to" AS to_col, on_delete FROM pragma_foreign_key_list(?)'
    ).all('registry_ref_assignments') as Array<{
      from_col: string;
      target: string;
      to_col: string;
      on_delete: string;
    }>;
    return (
      stateSql.includes('singletonintegerprimarykeycheck(singleton=1)') &&
      stateSql.includes('revisionintegernotnullcheck(revision>=0)') &&
      stateRows.length === 1 &&
      stateRows[0]?.singleton === 1 &&
      Number.isSafeInteger(stateRows[0]?.revision) &&
      (stateRows[0]?.revision ?? -1) >= 0 &&
      correctionInfo.get('command_id')?.pk === 1 &&
      [
        'command_id',
        'operation',
        'expected_revision',
        'committed_revision',
        'principal_id',
        'agent_id',
        'origin',
        'payload_json',
        'reason',
        'evidence_json',
        'scope_json',
        'receipt_json',
        'created_at',
      ].every((name) => {
        const column = correctionInfo.get(name);
        return ['expected_revision', 'committed_revision', 'created_at'].includes(name)
          ? column?.type.toUpperCase() === 'INTEGER'
          : column?.type.toUpperCase() === 'TEXT';
      }) &&
      [
        'operation',
        'expected_revision',
        'committed_revision',
        'origin',
        'payload_json',
        'reason',
        'evidence_json',
        'scope_json',
        'receipt_json',
        'created_at',
      ].every((column) => correctionInfo.get(column)?.notnull === 1) &&
      correctionsSql.includes("operationin('add_alias','merge','split','assign_refs')") &&
      correctionsSql.includes('expected_revision>=0') &&
      correctionsSql.includes('committed_revisionintegernotnullunique') &&
      correctionsSql.includes('committed_revision>expected_revision') &&
      correctionsSql.includes("originin('trusted','legacy_unattributed')") &&
      correctionsSql.includes('length(trim(reason))>0') &&
      correctionClauses.some((clause) => normalizeSqlText(clause) === aggregateAuthorityCheck) &&
      assignmentInfo.get('command_id')?.pk === 1 &&
      [
        'command_id',
        'edge_id',
        'endpoint',
        'original_kind',
        'original_id',
        'resolved_node_id',
        'committed_revision',
        'created_at',
      ].every((name) => {
        const column = assignmentInfo.get(name);
        return ['committed_revision', 'created_at'].includes(name)
          ? column?.type.toUpperCase() === 'INTEGER'
          : column?.type.toUpperCase() === 'TEXT';
      }) &&
      assignmentInfo.get('edge_id')?.pk === 2 &&
      assignmentInfo.get('endpoint')?.pk === 3 &&
      [
        'command_id',
        'edge_id',
        'endpoint',
        'original_kind',
        'original_id',
        'committed_revision',
        'created_at',
      ].every((column) => assignmentInfo.get(column)?.notnull === 1) &&
      assignmentInfo.get('resolved_node_id')?.notnull === 0 &&
      assignmentsSql.includes("endpointin('from','to')") &&
      assignmentFks.some(
        (fk) =>
          fk.from_col === 'command_id' &&
          fk.target === 'registry_corrections' &&
          fk.to_col === 'command_id' &&
          fk.on_delete.toUpperCase() === 'CASCADE'
      ) &&
      assignmentFks.some(
        (fk) =>
          fk.from_col === 'resolved_node_id' && fk.target === 'registry_nodes' && fk.to_col === 'id'
      )
    );
  }

  private needsRegistryCorrectionsRepair073(): boolean {
    return !this.registryCorrectionsShape073() || !this.schemaVersionExists(73);
  }

  private recoverRegistryCorrectionsMigration073(migrationsDir: string): void {
    const tables = ['registry_identity_state', 'registry_corrections', 'registry_ref_assignments'];
    const malformed = tables.filter(
      (table) =>
        this.tableExists(table) &&
        !(
          table === 'registry_identity_state'
            ? ['singleton', 'revision']
            : table === 'registry_corrections'
              ? [
                  'command_id',
                  'operation',
                  'expected_revision',
                  'committed_revision',
                  'principal_id',
                  'agent_id',
                  'origin',
                  'payload_json',
                  'reason',
                  'evidence_json',
                  'scope_json',
                  'receipt_json',
                  'created_at',
                ]
              : [
                  'command_id',
                  'edge_id',
                  'endpoint',
                  'original_kind',
                  'original_id',
                  'resolved_node_id',
                  'committed_revision',
                  'created_at',
                ]
        ).every((column) => this.tableColumns(table).has(column))
    );
    const allTablesPresent = tables.every((table) => this.tableExists(table));
    for (const table of tables) {
      if (!this.tableExists(table)) {
        continue;
      }
      const requiredColumns =
        table === 'registry_identity_state'
          ? ['singleton', 'revision']
          : table === 'registry_corrections'
            ? [
                'command_id',
                'operation',
                'expected_revision',
                'committed_revision',
                'principal_id',
                'agent_id',
                'origin',
                'payload_json',
                'reason',
                'evidence_json',
                'scope_json',
                'receipt_json',
                'created_at',
              ]
            : [
                'command_id',
                'edge_id',
                'endpoint',
                'original_kind',
                'original_id',
                'resolved_node_id',
                'committed_revision',
                'created_at',
              ];
      if (
        allTablesPresent &&
        requiredColumns.every((column) => this.tableColumns(table).has(column)) &&
        !this.registryCorrectionsShape073()
      ) {
        throw new Error(
          `Migration 073 cannot safely repair structurally incompatible table ${table}`
        );
      }
    }
    for (const table of malformed) {
      const count = (
        this.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`).get() as {
          count: number;
        }
      ).count;
      if (count > 0) {
        throw new Error(`Migration 073 cannot safely repair populated incompatible table ${table}`);
      }
      const excluded =
        table === 'registry_ref_assignments'
          ? new Set(['idx_registry_ref_assignments_current'])
          : new Set<string>();
      const objects = this.storedObjectsForTable(table, excluded);
      if (
        objects.indexes.length > 0 ||
        objects.triggers.length > 0 ||
        this.tablesInForeignKeyGraph(table).length > 1 ||
        /\b(?:check|unique|references)\b/i.test(this.tableSql(table))
      ) {
        throw new Error(`Migration 073 cannot safely replace incompatible table ${table}`);
      }
    }
    const sql = fs.readFileSync(path.join(migrationsDir, '073-registry-corrections.sql'), 'utf8');
    this.transaction(() => {
      if (malformed.includes('registry_ref_assignments')) {
        this.exec('DROP TABLE registry_ref_assignments');
      }
      if (malformed.includes('registry_corrections')) {
        this.exec('DROP TABLE registry_corrections');
      }
      if (malformed.includes('registry_identity_state')) {
        this.exec('DROP TABLE registry_identity_state');
      }
      this.exec(sql);
      if (!this.registryCorrectionsShape073()) {
        throw new Error('Migration 073 recovery failed: incomplete correction shape');
      }
      this.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)').run(
        73,
        'Atomic scoped registry correction history'
      );
    });
  }

  private workGraphRefsShape074(): boolean {
    if (!this.tableExists('twin_edges')) {
      return false;
    }
    const clauses = splitCreateTableClauses(this.tableSql('twin_edges'));
    const columnClauses = new Map(
      clauses
        .filter((clause) => !clauseIsTableConstraint(clause))
        .map((clause) => [clauseColumnName(clause), normalizeSqlText(clause)])
    );
    // 079 extends the relation list with 'refines','contradicts','amends'; a
    // table already at that shape satisfies the 074 endpoint contract too.
    const edgeTypeClause = clauses.find(
      (clause) => !clauseIsTableConstraint(clause) && clauseColumnName(clause) === 'edge_type'
    );
    const edgeTypeOk =
      edgeTypeClause !== undefined &&
      [
        "edge_type TEXT NOT NULL CHECK (edge_type IN ('supersedes','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks'))",
        "edge_type TEXT NOT NULL CHECK (edge_type IN ('supersedes','refines','contradicts','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks','amends'))",
      ].some((definition) => normalizeSqlText(edgeTypeClause) === normalizeSqlText(definition));
    const exactColumns = new Map<string, string>([
      [
        'confidence',
        'confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0)',
      ],
      ['source', "source TEXT NOT NULL CHECK (source IN ('agent','human','code'))"],
      ['content_hash', 'content_hash BLOB NOT NULL CHECK(length(content_hash)=32)'],
    ]);
    const required = [
      'edge_id',
      'edge_type',
      'subject_kind',
      'subject_id',
      'object_kind',
      'object_id',
      'relation_attrs_json',
      'confidence',
      'source',
      'agent_id',
      'model_run_id',
      'envelope_hash',
      'human_actor_id',
      'human_actor_role',
      'authority_scope_json',
      'reason_classification',
      'reason_text',
      'evidence_refs_json',
      'request_idempotency_key',
      'edge_idempotency_key',
      'content_hash',
      'created_at',
    ];
    const info = new Map(
      (
        this.prepare('PRAGMA table_info(twin_edges)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map((column) => [column.name, column])
    );
    return (
      required.every((column) => info.has(column)) &&
      required.every((column) => {
        const expected =
          column === 'confidence'
            ? 'REAL'
            : column === 'created_at'
              ? 'INTEGER'
              : column === 'content_hash'
                ? 'BLOB'
                : 'TEXT';
        return info.get(column)?.type.toUpperCase() === expected;
      }) &&
      info.get('edge_id')?.pk === 1 &&
      [
        'edge_type',
        'subject_kind',
        'subject_id',
        'object_kind',
        'object_id',
        'confidence',
        'source',
        'content_hash',
        'created_at',
      ].every((column) => info.get(column)?.notnull === 1) &&
      edgeTypeOk &&
      [...exactColumns].every(
        ([name, definition]) => columnClauses.get(name) === normalizeSqlText(definition)
      ) &&
      clauses.some(
        (clause) =>
          !clauseIsTableConstraint(clause) &&
          clauseColumnName(clause) === 'subject_kind' &&
          normalizeSqlText(clause) ===
            normalizeSqlText(
              "subject_kind TEXT NOT NULL CHECK (subject_kind IN ('memory','case','entity','report','edge','registry','observation'))"
            )
      ) &&
      clauses.some(
        (clause) =>
          !clauseIsTableConstraint(clause) &&
          clauseColumnName(clause) === 'object_kind' &&
          normalizeSqlText(clause) ===
            normalizeSqlText(
              "object_kind TEXT NOT NULL CHECK (object_kind IN ('memory','case','entity','report','edge','raw','registry','observation'))"
            )
      ) &&
      !clauses.some(
        (clause) =>
          clauseIsTableConstraint(clause) && /\b(?:subject_kind|object_kind)\b/i.test(clause)
      ) &&
      this.indexExists('idx_twin_edges_subject') &&
      this.indexExists('idx_twin_edges_object') &&
      this.indexExists('idx_twin_edges_model_run_id') &&
      this.indexExists('idx_twin_edges_request_idempotency') &&
      this.indexExists('ux_twin_edges_model_run_edge_idempotency') &&
      normalizeSqlText(this.indexSql('idx_twin_edges_subject')).includes(
        'ontwin_edges(subject_kind,subject_id,created_atdesc)'
      ) &&
      normalizeSqlText(this.indexSql('idx_twin_edges_object')).includes(
        'ontwin_edges(object_kind,object_id,created_atdesc)'
      ) &&
      normalizeSqlText(this.indexSql('idx_twin_edges_model_run_id')).includes(
        'ontwin_edges(model_run_id,created_atdesc)'
      ) &&
      normalizeSqlText(this.indexSql('idx_twin_edges_request_idempotency')).includes(
        'ontwin_edges(model_run_id,request_idempotency_key,created_atdesc)wheremodel_run_idisnotnullandrequest_idempotency_keyisnotnull'
      ) &&
      normalizeSqlText(this.indexSql('ux_twin_edges_model_run_edge_idempotency')).includes(
        'uniqueindexux_twin_edges_model_run_edge_idempotencyontwin_edges(model_run_id,edge_idempotency_key)wheremodel_run_idisnotnullandedge_idempotency_keyisnotnull'
      )
    );
  }

  private needsWorkGraphRefsRepair074(): boolean {
    return !this.workGraphRefsShape074() || !this.schemaVersionExists(74);
  }

  private recoverWorkGraphRefsMigration074(): void {
    if (!this.tableExists('twin_edges')) {
      throw new Error('Migration 074 recovery failed: missing twin_edges');
    }
    if (this.workGraphRefsShape074()) {
      this.transaction(() => {
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(74, 'Registry and observation work graph references');
      });
      return;
    }
    const clauses = splitCreateTableClauses(this.tableSql('twin_edges'));
    if (clauses.length === 0) {
      throw new Error('Migration 074 recovery failed: unreadable twin_edges');
    }
    const existingColumns: string[] = [];
    const columns: string[] = [];
    const constraints: string[] = [];
    const subjectDef =
      "subject_kind TEXT NOT NULL CHECK (subject_kind IN ('memory','case','entity','report','edge','registry','observation'))";
    const objectDef =
      "object_kind TEXT NOT NULL CHECK (object_kind IN ('memory','case','entity','report','edge','raw','registry','observation'))";
    const legacySubjectDef = normalizeSqlText(
      "subject_kind TEXT NOT NULL CHECK (subject_kind IN ('memory','case','entity','report','edge'))"
    );
    const legacyObjectDef = normalizeSqlText(
      "object_kind TEXT NOT NULL CHECK (object_kind IN ('memory','case','entity','report','edge','raw'))"
    );
    const exactProtectedColumns = new Map<string, string>([
      [
        'confidence',
        'confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0)',
      ],
      ['source', "source TEXT NOT NULL CHECK (source IN ('agent','human','code'))"],
      ['content_hash', 'content_hash BLOB NOT NULL CHECK(length(content_hash)=32)'],
    ]);
    // The edge_type CHECK was extended by migration 079; a table carrying the
    // newer relation list is preserved as-is instead of being rebuilt down.
    const allowedEdgeTypeDefs = new Set(
      [
        "edge_type TEXT NOT NULL CHECK (edge_type IN ('supersedes','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks'))",
        "edge_type TEXT NOT NULL CHECK (edge_type IN ('supersedes','refines','contradicts','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks','amends'))",
      ].map(normalizeSqlText)
    );
    for (const clause of clauses) {
      if (clauseIsTableConstraint(clause)) {
        if (/\b(?:subject_kind|object_kind)\b/i.test(clause)) {
          throw new Error('Migration 074 cannot safely preserve conflicting endpoint CHECK');
        }
        constraints.push(clause);
        continue;
      }
      const name = clauseColumnName(clause);
      existingColumns.push(name);
      if (name === 'subject_kind') {
        const normalizedClause = normalizeSqlText(clause);
        if (
          normalizedClause !== legacySubjectDef &&
          normalizedClause !== normalizeSqlText(subjectDef)
        ) {
          throw new Error('Migration 074 cannot safely preserve inline constraint on subject_kind');
        }
        columns.push(subjectDef);
      } else if (name === 'object_kind') {
        const normalizedClause = normalizeSqlText(clause);
        if (
          normalizedClause !== legacyObjectDef &&
          normalizedClause !== normalizeSqlText(objectDef)
        ) {
          throw new Error('Migration 074 cannot safely preserve inline constraint on object_kind');
        }
        columns.push(objectDef);
      } else if (name === 'edge_type') {
        if (!allowedEdgeTypeDefs.has(normalizeSqlText(clause))) {
          throw new Error('Migration 074 cannot safely preserve inline constraint on edge_type');
        }
        columns.push(clause);
      } else if (exactProtectedColumns.has(name)) {
        if (
          normalizeSqlText(clause) !== normalizeSqlText(exactProtectedColumns.get(name) as string)
        ) {
          throw new Error(`Migration 074 cannot safely preserve inline constraint on ${name}`);
        }
        columns.push(clause);
      } else {
        columns.push(clause);
      }
    }
    const objects = this.storedObjectsForTable(
      'twin_edges',
      new Set([
        'idx_twin_edges_subject',
        'idx_twin_edges_object',
        'idx_twin_edges_model_run_id',
        'idx_twin_edges_request_idempotency',
        'ux_twin_edges_model_run_edge_idempotency',
      ])
    );
    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      throw new Error('Migration 074 recovery failed: could not disable foreign_keys');
    }
    try {
      this.transaction(() => {
        this.exec(
          `CREATE TABLE twin_edges_074_new (\n  ${[...columns, ...constraints].join(',\n  ')}\n)`
        );
        const names = existingColumns.map(quoteSqlIdentifier).join(', ');
        this.exec(`INSERT INTO twin_edges_074_new (${names}) SELECT ${names} FROM twin_edges`);
        this.exec('DROP TABLE twin_edges');
        this.exec('ALTER TABLE twin_edges_074_new RENAME TO twin_edges');
        for (const sql of objects.indexes) {
          this.exec(sql);
        }
        this.exec(`
          CREATE INDEX idx_twin_edges_subject
            ON twin_edges(subject_kind, subject_id, created_at DESC);
          CREATE INDEX idx_twin_edges_object
            ON twin_edges(object_kind, object_id, created_at DESC);
          CREATE INDEX idx_twin_edges_model_run_id
            ON twin_edges(model_run_id, created_at DESC);
          CREATE INDEX idx_twin_edges_request_idempotency
            ON twin_edges(model_run_id, request_idempotency_key, created_at DESC)
            WHERE model_run_id IS NOT NULL AND request_idempotency_key IS NOT NULL;
          CREATE UNIQUE INDEX ux_twin_edges_model_run_edge_idempotency
            ON twin_edges(model_run_id, edge_idempotency_key)
            WHERE model_run_id IS NOT NULL AND edge_idempotency_key IS NOT NULL;
        `);
        for (const sql of objects.triggers) {
          this.exec(sql);
        }
        if (!this.workGraphRefsShape074()) {
          throw new Error('Migration 074 recovery failed: incomplete work graph shape');
        }
        for (const table of this.tablesInForeignKeyGraph('twin_edges')) {
          if (this.prepare('SELECT 1 FROM pragma_foreign_key_check(?)').all(table).length > 0) {
            throw new Error(
              `Migration 074 recovery failed: foreign key violations after rebuild (${table})`
            );
          }
        }
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(74, 'Registry and observation work graph references');
      });
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
  }

  /**
   * 079 endpoint shape: the 074 work-graph shape plus the extended edge_type
   * relation list ('refines','contradicts','amends') used by authored record
   * links. `workGraphRefsShape074` already accepts this edge_type variant, so
   * the extra check here is the only difference.
   */
  private twinEdgeRelationsShape079(): boolean {
    if (!this.tableExists('twin_edges')) {
      return false;
    }
    const clauses = splitCreateTableClauses(this.tableSql('twin_edges'));
    const edgeTypeClause = clauses.find(
      (clause) => !clauseIsTableConstraint(clause) && clauseColumnName(clause) === 'edge_type'
    );
    return (
      this.workGraphRefsShape074() &&
      edgeTypeClause !== undefined &&
      normalizeSqlText(edgeTypeClause) ===
        normalizeSqlText(
          "edge_type TEXT NOT NULL CHECK (edge_type IN ('supersedes','refines','contradicts','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks','amends'))"
        ) &&
      !clauses.some((clause) => clauseIsTableConstraint(clause) && /\bedge_type\b/i.test(clause))
    );
  }

  private needsTwinEdgeRelationsRepair079(): boolean {
    return !this.twinEdgeRelationsShape079() || !this.schemaVersionExists(79);
  }

  /**
   * Rebuild twin_edges with the extended relation CHECK while preserving every
   * existing column (including runtime-added custom columns), index, trigger,
   * and foreign-key child - the same contract recoverWorkGraphRefsMigration074
   * honours. Only the edge_type clause is rewritten; a table already carrying
   * the extended list is just stamped.
   */
  private recoverTwinEdgeRelationsMigration079(): void {
    if (!this.tableExists('twin_edges')) {
      throw new Error('Migration 079 recovery failed: missing twin_edges');
    }
    if (this.twinEdgeRelationsShape079()) {
      this.transaction(() => {
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(79, 'Twin edge relations for judgment links (refines/contradicts/amends)');
      });
      return;
    }
    const clauses = splitCreateTableClauses(this.tableSql('twin_edges'));
    if (clauses.length === 0) {
      throw new Error('Migration 079 recovery failed: unreadable twin_edges');
    }
    const edgeTypeDef =
      "edge_type TEXT NOT NULL CHECK (edge_type IN ('supersedes','refines','contradicts','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks','amends'))";
    const allowedEdgeTypeDefs = new Set(
      [
        "edge_type TEXT NOT NULL CHECK (edge_type IN ('supersedes','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks'))",
        edgeTypeDef,
      ].map(normalizeSqlText)
    );
    const existingColumns: string[] = [];
    const columns: string[] = [];
    const constraints: string[] = [];
    for (const clause of clauses) {
      if (clauseIsTableConstraint(clause)) {
        if (/\bedge_type\b/i.test(clause)) {
          throw new Error('Migration 079 cannot safely preserve conflicting edge_type CHECK');
        }
        constraints.push(clause);
        continue;
      }
      const name = clauseColumnName(clause);
      existingColumns.push(name);
      if (name === 'edge_type') {
        if (!allowedEdgeTypeDefs.has(normalizeSqlText(clause))) {
          throw new Error('Migration 079 cannot safely preserve inline constraint on edge_type');
        }
        columns.push(edgeTypeDef);
      } else {
        columns.push(clause);
      }
    }
    const objects = this.storedObjectsForTable(
      'twin_edges',
      new Set([
        'idx_twin_edges_subject',
        'idx_twin_edges_object',
        'idx_twin_edges_model_run_id',
        'idx_twin_edges_request_idempotency',
        'ux_twin_edges_model_run_edge_idempotency',
      ])
    );
    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      throw new Error('Migration 079 recovery failed: could not disable foreign_keys');
    }
    try {
      this.transaction(() => {
        this.exec(
          `CREATE TABLE twin_edges_079_new (\n  ${[...columns, ...constraints].join(',\n  ')}\n)`
        );
        // Generated columns (table_xinfo hidden: 2 = VIRTUAL, 3 = STORED) refuse
        // direct writes; the rebuilt table recomputes them from its own clause.
        const generatedColumns = new Set(
          (
            this.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(
              'twin_edges'
            ) as Array<{ name: string }>
          ).map((row) => row.name)
        );
        const names = existingColumns
          .filter((name) => !generatedColumns.has(name))
          .map(quoteSqlIdentifier)
          .join(', ');
        this.exec(`INSERT INTO twin_edges_079_new (${names}) SELECT ${names} FROM twin_edges`);
        this.exec('DROP TABLE twin_edges');
        this.exec('ALTER TABLE twin_edges_079_new RENAME TO twin_edges');
        for (const sql of objects.indexes) {
          this.exec(sql);
        }
        this.exec(`
          CREATE INDEX idx_twin_edges_subject
            ON twin_edges(subject_kind, subject_id, created_at DESC);
          CREATE INDEX idx_twin_edges_object
            ON twin_edges(object_kind, object_id, created_at DESC);
          CREATE INDEX idx_twin_edges_model_run_id
            ON twin_edges(model_run_id, created_at DESC);
          CREATE INDEX idx_twin_edges_request_idempotency
            ON twin_edges(model_run_id, request_idempotency_key, created_at DESC)
            WHERE model_run_id IS NOT NULL AND request_idempotency_key IS NOT NULL;
          CREATE UNIQUE INDEX ux_twin_edges_model_run_edge_idempotency
            ON twin_edges(model_run_id, edge_idempotency_key)
            WHERE model_run_id IS NOT NULL AND edge_idempotency_key IS NOT NULL;
        `);
        for (const sql of objects.triggers) {
          this.exec(sql);
        }
        if (!this.twinEdgeRelationsShape079()) {
          throw new Error('Migration 079 recovery failed: incomplete twin edge relations shape');
        }
        for (const table of this.tablesInForeignKeyGraph('twin_edges')) {
          if (this.prepare('SELECT 1 FROM pragma_foreign_key_check(?)').all(table).length > 0) {
            throw new Error(
              `Migration 079 recovery failed: foreign key violations after rebuild (${table})`
            );
          }
        }
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(79, 'Twin edge relations for judgment links (refines/contradicts/amends)');
      });
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
  }

  private legacyRecordKindShape077(): boolean {
    if (!this.tableExists('decisions')) {
      return false;
    }
    const clauses = splitCreateTableClauses(this.tableSql('decisions'));
    const recordKindClause = clauses.find(
      (clause) => !clauseIsTableConstraint(clause) && clauseColumnName(clause) === 'record_kind'
    );
    return Boolean(
      recordKindClause &&
      normalizeSqlText(recordKindClause) ===
        normalizeSqlText(
          "record_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (record_kind IN ('legacy', 'judgment', 'commitment'))"
        ) &&
      !clauses.some((clause) => clauseIsTableConstraint(clause) && /\brecord_kind\b/i.test(clause))
    );
  }

  private recoverLegacyRecordKindMigration077(): void {
    if (!this.tableExists('decisions')) {
      throw new Error('Migration 077 recovery failed: missing decisions');
    }
    if (this.legacyRecordKindShape077()) {
      this.transaction(() => {
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(77, 'Distinguish legacy memory records from agent judgments');
      });
      return;
    }

    const clauses = splitCreateTableClauses(this.tableSql('decisions'));
    if (clauses.length === 0) {
      throw new Error('Migration 077 recovery failed: unreadable decisions');
    }
    const existingColumns: string[] = [];
    const columns: string[] = [];
    const constraints: string[] = [];
    let hasRecordKind = false;
    for (const clause of clauses) {
      if (clauseIsTableConstraint(clause)) {
        if (/\brecord_kind\b/i.test(clause)) {
          throw new Error('Migration 077 cannot safely preserve conflicting record_kind CHECK');
        }
        constraints.push(clause);
        continue;
      }
      const name = clauseColumnName(clause);
      existingColumns.push(name);
      if (name === 'record_kind') {
        hasRecordKind = true;
        columns.push(
          "record_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (record_kind IN ('legacy', 'judgment', 'commitment'))"
        );
      } else {
        columns.push(clause);
      }
    }
    if (!hasRecordKind) {
      throw new Error('Migration 077 recovery failed: record_kind column is missing');
    }

    const objects = this.storedObjectsForTable('decisions');
    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      throw new Error('Migration 077 recovery failed: could not disable foreign_keys');
    }
    try {
      this.transaction(() => {
        this.exec(
          `CREATE TABLE decisions_077_new (\n  ${[...columns, ...constraints].join(',\n  ')}\n)`
        );
        const names = existingColumns.map(quoteSqlIdentifier).join(', ');
        const source = existingColumns
          .map((name) =>
            name === 'record_kind'
              ? `CASE WHEN ${this.tableExists('judgment_commands') ? 'EXISTS (SELECT 1 FROM judgment_commands jc WHERE jc.record_id = decisions.id)' : '0'} THEN record_kind ELSE 'legacy' END`
              : quoteSqlIdentifier(name)
          )
          .join(', ');
        this.exec(`INSERT INTO decisions_077_new (${names}) SELECT ${source} FROM decisions`);
        this.exec('DROP TABLE decisions');
        this.exec('ALTER TABLE decisions_077_new RENAME TO decisions');
        for (const sql of objects.indexes) {
          this.exec(sql);
        }
        for (const sql of objects.triggers) {
          this.exec(sql);
        }
        if (!this.legacyRecordKindShape077()) {
          throw new Error('Migration 077 recovery failed: incomplete record_kind shape');
        }
        for (const table of this.tablesInForeignKeyGraph('decisions')) {
          if (this.prepare('SELECT 1 FROM pragma_foreign_key_check(?)').all(table).length > 0) {
            throw new Error(
              `Migration 077 recovery failed: foreign key violations after rebuild (${table})`
            );
          }
        }
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(77, 'Distinguish legacy memory records from agent judgments');
      });
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
  }

  private toolTracesHasOperationOriginShape(): boolean {
    const columns = this.tableColumns('tool_traces');
    if (!columns.has('operation_id') || !columns.has('actor_principal_id')) {
      return false;
    }
    const modelRunColumn = (
      this.prepare('PRAGMA table_info(tool_traces)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === 'model_run_id');
    if (!modelRunColumn || modelRunColumn.notnull !== 0) {
      return false;
    }
    const normalized = normalizeSqlText(this.toolTracesTableSql());
    // The FULL origin CHECK must be present, not merely a prefix: a weakened
    // `CHECK (model_run_id IS NOT NULL OR 1)` would let a both-null-origin row
    // exist, so a table carrying it is NOT migrated and must be repaired.
    if (!normalized.includes(normalizeSqlText(TOOL_TRACES_ORIGIN_CHECK))) {
      return false;
    }
    // The model_runs FK must survive so a legacy/causal model reference is real.
    if (!normalized.includes(normalizeSqlText(TOOL_TRACES_MODEL_FK))) {
      return false;
    }
    // The origin lookup indexes are part of the shape this migration guarantees.
    return (
      this.indexExists('idx_tool_traces_operation_id') &&
      this.indexExists('idx_tool_traces_actor_principal')
    );
  }

  private needsServiceOperationOriginsRepair071(): boolean {
    if (!this.tableExists('tool_traces')) {
      // The table itself is missing: let the recovery helper fail loudly.
      return true;
    }
    return !this.toolTracesHasOperationOriginShape() || !this.schemaVersionExists(71);
  }

  private readForeignKeysEnabled(): boolean {
    const row = this.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
    return Boolean(row?.foreign_keys);
  }

  /**
   * tool_traces plus every table that declares a FK referencing it. This is the
   * relevant FK graph for the 071 rebuild: tool_traces' own model_runs reference
   * and any child (e.g. an ON DELETE CASCADE table) whose rows the rebuild must
   * have preserved. A valid child whose table name needs quoting (a space, an
   * embedded quote, a reserved word) is inspected correctly too: the name is fed
   * to the table-valued pragma as a bound argument, not interpolated -- so no
   * referencing child is silently skipped by an identifier regex.
   */
  private tablesInToolTracesFkGraph(): string[] {
    const graph = new Set<string>(['tool_traces']);
    const tables = this.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const fkList = this.prepare('SELECT "table" AS ref FROM pragma_foreign_key_list(?)').all(
        name
      ) as Array<{ ref?: string }>;
      if (fkList.some((fk) => fk.ref === 'tool_traces')) {
        graph.add(name);
      }
    }
    return [...graph];
  }

  private recoverServiceOperationOriginsMigration071(): void {
    if (!this.tableExists('tool_traces')) {
      throw new Error('Migration 071 recovery failed: missing table tool_traces');
    }

    // Idempotent: a database already carrying the full operation-origin shape
    // only needs its schema_version stamped. Never infer health from version.
    if (this.toolTracesHasOperationOriginShape()) {
      this.transaction(() => {
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(71, 'Service operation-origin tool traces');
      });
      return;
    }

    // The 071 rebuild recreates the 068 scope indexes, which reference
    // owner_scope/project_id/channel_id. A legacy ledger stamped 68 but missing
    // those diagnostic columns (the main loop skips version 68 when it is
    // already stamped, so the in-loop 071 branch reaches here before the
    // end-of-run repair) would abort the rebuild with "no such column". Repair
    // the real 068 prerequisite first, reusing the same structural dependency
    // the late repair path already orders (068 before 071). This runs before
    // the FK toggle/transaction below, so no nested transaction is introduced,
    // and it is a no-op on a healthy database.
    if (this.needsToolTraceDiagnosticsRepair068()) {
      this.recoverToolTraceDiagnosticsMigration068();
    }

    // FK enforcement MUST be toggled OUTSIDE a transaction (SQLite silently
    // ignores the pragma while one is open). Disabling it before BEGIN is what
    // stops the DROP TABLE below from CASCADE-deleting real child rows; the
    // whole-graph foreign_key_check inside the transaction is the honest
    // preservation proof, never a post-deletion recount. Restore in finally.
    const previousForeignKeys = this.readForeignKeysEnabled();
    this.exec('PRAGMA foreign_keys = OFF');
    if (this.readForeignKeysEnabled()) {
      // A pragma that did not take effect means a transaction is already open;
      // proceeding would let CASCADE run. Refuse rather than pretend it worked.
      throw new Error(
        'Migration 071 recovery failed: could not disable foreign_keys (transaction already open?)'
      );
    }
    try {
      this.transaction(() => {
        // Preserve the COMPLETE existing table definition. Every column keeps its
        // exact declared type, NOT NULL/DEFAULT/CHECK/UNIQUE/COLLATE and quoted
        // name; only model_run_id is relaxed to nullable and the two origin
        // columns + origin CHECK are added. Reconstructing from name/type alone
        // would silently drop constraints and defaults a live database carries.
        const originalSql = this.toolTracesTableSql();
        const clauses = splitCreateTableClauses(originalSql);
        if (clauses.length === 0) {
          throw new Error('Migration 071 recovery failed: could not read tool_traces definition');
        }

        const existingColumnNames: string[] = [];
        const columnDefs: string[] = [];
        const constraintDefs: string[] = [];
        for (const clause of clauses) {
          if (clauseIsTableConstraint(clause)) {
            constraintDefs.push(clause);
            continue;
          }
          const name = clauseColumnName(clause);
          existingColumnNames.push(name);
          if (name === 'model_run_id') {
            // Relax the single NOT NULL so an operation-origin row (model NULL)
            // is allowed; everything else about the column is preserved.
            columnDefs.push(clause.replace(/\s+not\s+null\b/i, ''));
          } else {
            columnDefs.push(clause);
          }
        }

        const present = new Set(existingColumnNames);
        if (!present.has('operation_id')) {
          columnDefs.push('operation_id TEXT');
        }
        if (!present.has('actor_principal_id')) {
          columnDefs.push('actor_principal_id TEXT');
        }

        const constraints = [...constraintDefs];
        const hasModelFk = constraints.some((clause) =>
          normalizeSqlText(clause).includes('referencesmodel_runs(model_run_id)')
        );
        if (!hasModelFk) {
          constraints.push(TOOL_TRACES_MODEL_FK);
        }
        constraints.push(TOOL_TRACES_ORIGIN_CHECK);

        // Preserve every custom/existing trigger on the old table; DROP TABLE
        // drops them, and RENAME does not carry them, so recreate from DDL.
        const triggerSqls = (
          this.prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='tool_traces' AND sql IS NOT NULL"
          ).all() as Array<{ sql: string }>
        ).map((row) => row.sql);

        // Preserve every non-auto index on the old table (033/061/068 plus any
        // runtime-created ones) by recreating them from their stored DDL.
        const indexSqls = (
          this.prepare(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tool_traces' AND sql IS NOT NULL"
          ).all() as Array<{ sql: string }>
        ).map((row) => row.sql);

        this.exec(
          `CREATE TABLE tool_traces_071_new (\n  ${[...columnDefs, ...constraints].join(',\n  ')}\n)`
        );

        // Copy every column the old table actually carries (canonical, runtime
        // extras, and any already-present operation_id/actor_principal_id values
        // from a partially-repaired shape - never dropping real origin values).
        // Each name is re-quoted: clauseColumnName decoded it, so a quoted name
        // carrying a space/embedded-quote/reserved word must be emitted quoted or
        // it would parse as several bare tokens and abort the rebuild.
        const columnList = existingColumnNames.map(quoteSqlIdentifier).join(', ');
        this.exec(
          `INSERT INTO tool_traces_071_new (${columnList}) SELECT ${columnList} FROM tool_traces`
        );

        this.exec('DROP TABLE tool_traces');
        this.exec('ALTER TABLE tool_traces_071_new RENAME TO tool_traces');
        for (const sql of indexSqls) {
          this.exec(sql.replace(/^CREATE\s+INDEX/i, 'CREATE INDEX IF NOT EXISTS'));
        }
        this.exec(`
          CREATE INDEX IF NOT EXISTS idx_tool_traces_model_run_id
            ON tool_traces(model_run_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_tool_traces_gateway_call_id
            ON tool_traces(gateway_call_id);
          CREATE INDEX IF NOT EXISTS idx_tool_traces_scope_recency
            ON tool_traces(owner_scope, project_id, created_at DESC, trace_id DESC);
          CREATE INDEX IF NOT EXISTS idx_tool_traces_channel_recency
            ON tool_traces(owner_scope, project_id, channel_id, created_at DESC, trace_id DESC);
          CREATE INDEX IF NOT EXISTS idx_tool_traces_operation_id
            ON tool_traces(operation_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_tool_traces_actor_principal
            ON tool_traces(actor_principal_id, created_at DESC);
        `);
        for (const sql of triggerSqls) {
          this.exec(sql);
        }

        if (!this.toolTracesHasOperationOriginShape()) {
          throw new Error(
            'Migration 071 recovery failed: operation-origin shape missing after rebuild'
          );
        }
        // Validate the RELEVANT FK graph, not merely tool_traces' own FK: check
        // tool_traces (its model_runs reference - catches a dangling row) AND
        // every table that references tool_traces (a CASCADE child that the
        // rebuild must have preserved). Any violation aborts the whole
        // transaction, so nothing partial or unattributed is ever committed.
        // Unrelated tables are deliberately NOT checked - a pre-existing
        // violation elsewhere must not block this upgrade.
        for (const table of this.tablesInToolTracesFkGraph()) {
          const violations = this.prepare('SELECT 1 FROM pragma_foreign_key_check(?)').all(table);
          if (violations.length > 0) {
            throw new Error(
              `Migration 071 recovery failed: foreign key violations after rebuild (${table})`
            );
          }
        }
        this.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)'
        ).run(71, 'Service operation-origin tool traces');
      });
    } finally {
      this.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
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
        CREATE INDEX IF NOT EXISTS idx_decisions_topic
          ON decisions(topic)
      `);
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

  private indexSql(indexName: string): string {
    if (!SQLITE_IDENTIFIER_PATTERN.test(indexName)) {
      throw new Error('Invalid SQLite index identifier');
    }
    const row = this.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(
      indexName
    ) as { sql?: string } | undefined;
    return row?.sql ?? '';
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
