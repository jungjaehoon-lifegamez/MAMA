/**
 * Agent Version, Metrics & Activity Store
 *
 * SQLite storage for agent version history, per-version metrics, and activity logs.
 * Follows Managed Agents optimistic concurrency pattern.
 */

import type { SQLiteDatabase } from '../sqlite.js';
import { applyAgentStoreTablesMigration } from './migrations/agent-store-tables.js';
import { applyAgentMetricsResponseAverageMigration } from './migrations/agent-metrics-response-avg.js';
import { applyAgentActivityValidationColumnsMigration } from './migrations/agent-activity-validation-columns.js';

type DB = SQLiteDatabase;

const TERMINAL_ACTIVITY_TYPES = new Set([
  'task_complete',
  'task_error',
  'task_skipped',
  'audit_complete',
  'audit_failed',
]);

const TERMINAL_OUTCOME_ACTIVITY_SQL = [
  "'task_complete'",
  "'task_error'",
  "'task_skipped'",
  "'audit_complete'",
  "'audit_failed'",
].join(', ');

// ── Table Init ──────────────────────────────────────────────────────────────

export function initAgentTables(db: SQLiteDatabase): void {
  applyAgentStoreTablesMigration(db);
  applyAgentMetricsResponseAverageMigration(db);
  applyAgentActivityValidationColumnsMigration(db);
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
  response_ms_sum?: number;
  response_count?: number;
}

export interface VersionComparison {
  version_a: { version: number } & Partial<MetricsRow>;
  version_b: { version: number } & Partial<MetricsRow>;
}

// ── Version CRUD ────────────────────────────────────────────────────────────

export function createAgentVersion(db: SQLiteDatabase, input: CreateVersionInput): AgentVersionRow {
  const snapshotJson = JSON.stringify(input.snapshot);
  const tx = db.transaction(() => {
    const latest = getLatestVersion(db, input.agent_id);

    if (
      latest &&
      latest.snapshot === snapshotJson &&
      latest.persona_text === (input.persona_text ?? null)
    ) {
      return latest;
    }

    const result = db
      .prepare(
        `INSERT INTO agent_versions (agent_id, version, snapshot, persona_text, change_note)
         SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?
         FROM agent_versions
         WHERE agent_id = ?`
      )
      .run(
        input.agent_id,
        snapshotJson,
        input.persona_text ?? null,
        input.change_note ?? null,
        input.agent_id
      );
    return db
      .prepare('SELECT * FROM agent_versions WHERE id = ?')
      .get(result.lastInsertRowid) as AgentVersionRow;
  });

  return tx();
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
  const responseMs = input.avg_response_ms ?? 0;
  const responseCount = input.avg_response_ms !== undefined ? 1 : 0;
  db.prepare(
    `INSERT INTO agent_metrics (agent_id, agent_version, period_start, period_end,
      input_tokens, output_tokens, tool_calls, delegations, errors, avg_response_ms, response_ms_sum, response_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, agent_version, period_start) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      tool_calls = tool_calls + excluded.tool_calls,
      delegations = delegations + excluded.delegations,
      errors = errors + excluded.errors,
      response_ms_sum = response_ms_sum + excluded.response_ms_sum,
      response_count = response_count + excluded.response_count,
      avg_response_ms = CASE
        WHEN (response_count + excluded.response_count) > 0
          THEN (response_ms_sum + excluded.response_ms_sum) * 1.0 / (response_count + excluded.response_count)
        ELSE 0
      END`
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
    responseCount > 0 ? responseMs : 0,
    responseMs,
    responseCount
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
  const ensureMetricsVersionExists = (ver: number): void => {
    const exists = db
      .prepare(
        'SELECT EXISTS(SELECT 1 FROM agent_metrics WHERE agent_id = ? AND agent_version = ?) as present'
      )
      .get(agentId, ver) as { present: number };
    if (!exists.present) {
      throw new Error(`No metrics found for agent '${agentId}' version ${ver}`);
    }
  };
  const sumForVersion = (ver: number) => {
    ensureMetricsVersionExists(ver);
    return db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) as input_tokens,
           COALESCE(SUM(output_tokens),0) as output_tokens,
           COALESCE(SUM(tool_calls),0) as tool_calls,
           COALESCE(SUM(delegations),0) as delegations,
           COALESCE(SUM(errors),0) as errors
    FROM agent_metrics WHERE agent_id = ? AND agent_version = ?`
      )
      .get(agentId, ver) as MetricsRow;
  };

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
  run_id?: string;
  execution_status?: string;
  trigger_reason?: string;
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
  run_id: string | null;
  execution_status: string | null;
  trigger_reason: string | null;
  created_at: string;
}

// ── Activity CRUD ──────────────────────────────────────────────────────────

export function logActivity(db: DB, input: LogActivityInput): ActivityRow {
  const stmt = db.prepare(`
    INSERT INTO agent_activity (
      agent_id, agent_version, type, input_summary, output_summary, tokens_used,
      tools_called, duration_ms, score, details, error_message, run_id, execution_status, trigger_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.error_message ?? null,
    input.run_id ?? null,
    input.execution_status ?? null,
    input.trigger_reason ?? null
  );
  return db
    .prepare('SELECT * FROM agent_activity WHERE id = ?')
    .get(result.lastInsertRowid) as ActivityRow;
}

export function updateActivityScore(
  db: DB,
  activityId: number,
  score: number,
  details: Record<string, unknown>,
  executionStatus?: string
): ActivityRow {
  db.prepare(
    `UPDATE agent_activity
     SET score = ?, details = ?, execution_status = COALESCE(?, execution_status)
     WHERE id = ?`
  ).run(score, JSON.stringify(details), executionStatus ?? null, activityId);
  return db.prepare('SELECT * FROM agent_activity WHERE id = ?').get(activityId) as ActivityRow;
}

export function getActivity(db: DB, agentId: string, limit: number): ActivityRow[] {
  return db
    .prepare(
      'SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    .all(agentId, limit) as ActivityRow[];
}

// ── Activity Summary ───────────────────────────────────────────────────────

export interface ActivitySummaryRow {
  agent_id: string;
  total: number;
  completed: number;
  errors: number;
  error_rate: number;
  consecutive_errors: number;
  last_activity_type: string | null;
  last_activity_at: string | null;
  avg_duration_ms: number;
}

export function getActivitySummary(db: DB, since: string): ActivitySummaryRow[] {
  // Single query with CTEs — includes recent types per agent to avoid N+1 lookups.
  const rows = db
    .prepare(
      `WITH
        agg AS (
          SELECT
            agent_id,
            COUNT(CASE WHEN type IN (${TERMINAL_OUTCOME_ACTIVITY_SQL}) THEN 1 END) as total,
            SUM(CASE WHEN type IN ('task_complete', 'audit_complete') THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN type IN ('task_error', 'audit_failed') THEN 1 ELSE 0 END) as errors,
            ROUND(
              COALESCE(
                SUM(CASE WHEN type IN ('task_error', 'audit_failed') THEN 1.0 ELSE 0 END)
                / NULLIF(COUNT(CASE WHEN type IN (${TERMINAL_OUTCOME_ACTIVITY_SQL}) THEN 1 END), 0)
                * 100,
                0
              ),
              2
            ) as error_rate,
            AVG(CASE WHEN type IN (${TERMINAL_OUTCOME_ACTIVITY_SQL}) AND duration_ms > 0 THEN duration_ms END) as avg_duration_ms
          FROM agent_activity
          WHERE created_at >= ?
          GROUP BY agent_id
        ),
        latest AS (
          SELECT agent_id, type as last_type, created_at as last_at,
            ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC, id DESC) as rn
          FROM agent_activity
          WHERE created_at >= ?
        ),
        recent AS (
          SELECT agent_id, type, rn
          FROM (
            SELECT
              agent_id,
              type,
              ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC, id DESC) as rn
            FROM agent_activity
            WHERE created_at >= ?
          )
          WHERE rn <= 10
        ),
        recent_joined AS (
          SELECT agent_id, GROUP_CONCAT(type, '|') as recent_types
          FROM (
            SELECT agent_id, type, rn
            FROM recent
            ORDER BY agent_id, rn
          )
          GROUP BY agent_id
        )
      SELECT
        agg.*,
        latest.last_type,
        latest.last_at,
        recent_joined.recent_types
      FROM agg
      LEFT JOIN latest ON agg.agent_id = latest.agent_id AND latest.rn = 1
      LEFT JOIN recent_joined ON agg.agent_id = recent_joined.agent_id
      ORDER BY agg.total DESC`
    )
    .all(since, since, since) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const agentId = String(row.agent_id);
    const recentTypes = String(row.recent_types ?? '')
      .split('|')
      .filter((value) => value.length > 0)
      .filter((type) => TERMINAL_ACTIVITY_TYPES.has(type))
      .map((type) => ({ type }));
    let consecutiveErrors = 0;
    for (const r of recentTypes) {
      if (r.type === 'task_error' || r.type === 'audit_failed') {
        consecutiveErrors++;
      } else {
        break;
      }
    }

    return {
      agent_id: agentId,
      total: Number(row.total),
      completed: Number(row.completed),
      errors: Number(row.errors),
      error_rate: Number(row.error_rate),
      consecutive_errors: consecutiveErrors,
      last_activity_type: row.last_type ? String(row.last_type) : null,
      last_activity_at: row.last_at ? String(row.last_at) : null,
      avg_duration_ms: Math.round(Number(row.avg_duration_ms ?? 0)),
    };
  });
}
