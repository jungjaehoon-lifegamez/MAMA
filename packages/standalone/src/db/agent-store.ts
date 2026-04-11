/**
 * Agent Version, Metrics & Activity Store
 *
 * SQLite storage for agent version history, per-version metrics, and activity logs.
 * Follows Managed Agents optimistic concurrency pattern.
 */

import type { SQLiteDatabase } from '../sqlite.js';

type DB = SQLiteDatabase;

// ── Table Init ──────────────────────────────────────────────────────────────

export function initAgentTables(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL,
      version      INTEGER NOT NULL,
      snapshot     TEXT NOT NULL,
      persona_text TEXT,
      change_note  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, version)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      agent_version   INTEGER NOT NULL,
      period_start    TEXT NOT NULL,
      period_end      TEXT NOT NULL,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      tool_calls      INTEGER DEFAULT 0,
      delegations     INTEGER DEFAULT 0,
      errors          INTEGER DEFAULT 0,
      avg_response_ms REAL DEFAULT 0,
      UNIQUE(agent_id, agent_version, period_start)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent_id, agent_version)`
  );

  // ── agent_activity ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      agent_version   INTEGER NOT NULL,
      type            TEXT NOT NULL,
      input_summary   TEXT,
      output_summary  TEXT,
      tokens_used     INTEGER DEFAULT 0,
      tools_called    TEXT,
      duration_ms     INTEGER DEFAULT 0,
      score           REAL,
      details         TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity(agent_id, created_at)`
  );
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface CreateVersionInput {
  agent_id: string;
  snapshot: Record<string, unknown>;
  persona_text?: string | null;
  change_note?: string | null;
}

export interface AgentVersionRow {
  id: number;
  agent_id: string;
  version: number;
  snapshot: string;
  persona_text: string | null;
  change_note: string | null;
  created_at: string;
}

export interface UpsertMetricsInput {
  agent_id: string;
  agent_version: number;
  period_start: string;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: number;
  delegations?: number;
  errors?: number;
  avg_response_ms?: number;
}

export interface MetricsRow {
  agent_id: string;
  agent_version: number;
  period_start: string;
  period_end: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  delegations: number;
  errors: number;
  avg_response_ms: number;
}

export interface VersionComparison {
  version_a: { version: number } & Partial<MetricsRow>;
  version_b: { version: number } & Partial<MetricsRow>;
}

// ── Version CRUD ────────────────────────────────────────────────────────────

export function createAgentVersion(db: SQLiteDatabase, input: CreateVersionInput): AgentVersionRow {
  const snapshotJson = JSON.stringify(input.snapshot);
  const latest = getLatestVersion(db, input.agent_id);

  // No-op detection: identical snapshot → return existing
  if (latest && latest.snapshot === snapshotJson) {
    return latest;
  }

  const nextVersion = latest ? latest.version + 1 : 1;
  const result = db
    .prepare(
      `INSERT INTO agent_versions (agent_id, version, snapshot, persona_text, change_note)
     VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.agent_id,
      nextVersion,
      snapshotJson,
      input.persona_text ?? null,
      input.change_note ?? null
    );
  return db
    .prepare('SELECT * FROM agent_versions WHERE id = ?')
    .get(result.lastInsertRowid) as AgentVersionRow;
}

export function getLatestVersion(db: SQLiteDatabase, agentId: string): AgentVersionRow | null {
  return (
    (db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1')
      .get(agentId) as AgentVersionRow | undefined) ?? null
  );
}

export function getAgentVersion(
  db: SQLiteDatabase,
  agentId: string,
  version: number
): AgentVersionRow | null {
  return (
    (db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?')
      .get(agentId, version) as AgentVersionRow | undefined) ?? null
  );
}

export function listVersions(db: SQLiteDatabase, agentId: string): AgentVersionRow[] {
  return db
    .prepare('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC')
    .all(agentId) as AgentVersionRow[];
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export function upsertMetrics(db: SQLiteDatabase, input: UpsertMetricsInput): void {
  db.prepare(
    `INSERT INTO agent_metrics (agent_id, agent_version, period_start, period_end,
      input_tokens, output_tokens, tool_calls, delegations, errors, avg_response_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, agent_version, period_start) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      tool_calls = tool_calls + excluded.tool_calls,
      delegations = delegations + excluded.delegations,
      errors = errors + excluded.errors`
  ).run(
    input.agent_id,
    input.agent_version,
    input.period_start,
    input.period_start, // period_end = same day for daily granularity
    input.input_tokens ?? 0,
    input.output_tokens ?? 0,
    input.tool_calls ?? 0,
    input.delegations ?? 0,
    input.errors ?? 0,
    input.avg_response_ms ?? 0
  );
}

export function getMetrics(
  db: SQLiteDatabase,
  agentId: string,
  from: string,
  to: string
): MetricsRow[] {
  return db
    .prepare(
      'SELECT * FROM agent_metrics WHERE agent_id = ? AND period_start >= ? AND period_start < ? ORDER BY period_start'
    )
    .all(agentId, from, to) as MetricsRow[];
}

export function compareVersionMetrics(
  db: SQLiteDatabase,
  agentId: string,
  versionA: number,
  versionB: number
): VersionComparison {
  const sumForVersion = (ver: number) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) as input_tokens,
           COALESCE(SUM(output_tokens),0) as output_tokens,
           COALESCE(SUM(tool_calls),0) as tool_calls,
           COALESCE(SUM(delegations),0) as delegations,
           COALESCE(SUM(errors),0) as errors
    FROM agent_metrics WHERE agent_id = ? AND agent_version = ?`
      )
      .get(agentId, ver) as MetricsRow;

  return {
    version_a: { version: versionA, ...sumForVersion(versionA) },
    version_b: { version: versionB, ...sumForVersion(versionB) },
  };
}

// ── Activity Types ─────────────────────────────────────────────────────────

export interface LogActivityInput {
  agent_id: string;
  agent_version: number;
  type: string;
  input_summary?: string;
  output_summary?: string;
  tokens_used?: number;
  tools_called?: string[];
  duration_ms?: number;
  score?: number;
  details?: Record<string, unknown>;
  error_message?: string;
}

export interface ActivityRow {
  id: number;
  agent_id: string;
  agent_version: number;
  type: string;
  input_summary: string | null;
  output_summary: string | null;
  tokens_used: number;
  tools_called: string | null;
  duration_ms: number;
  score: number | null;
  details: string | null;
  error_message: string | null;
  created_at: string;
}

// ── Activity CRUD ──────────────────────────────────────────────────────────

export function logActivity(db: DB, input: LogActivityInput): ActivityRow {
  const stmt = db.prepare(`
    INSERT INTO agent_activity (agent_id, agent_version, type, input_summary, output_summary, tokens_used, tools_called, duration_ms, score, details, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.agent_id,
    input.agent_version,
    input.type,
    input.input_summary ?? null,
    input.output_summary ?? null,
    input.tokens_used ?? 0,
    input.tools_called ? JSON.stringify(input.tools_called) : null,
    input.duration_ms ?? 0,
    input.score ?? null,
    input.details ? JSON.stringify(input.details) : null,
    input.error_message ?? null
  );
  return db
    .prepare('SELECT * FROM agent_activity WHERE id = ?')
    .get(result.lastInsertRowid) as ActivityRow;
}

export function getActivity(db: DB, agentId: string, limit: number): ActivityRow[] {
  return db
    .prepare(
      'SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    .all(agentId, limit) as ActivityRow[];
}
