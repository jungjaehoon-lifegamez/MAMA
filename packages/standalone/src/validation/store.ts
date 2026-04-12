/**
 * Validation Session Store
 *
 * SQLite persistence for validation_sessions, validation_metrics,
 * and agent_validation_state. Includes ALTER TABLE migration for
 * agent_activity (run_id, execution_status, trigger_reason).
 */

import type { SQLiteDatabase } from '../sqlite.js';
import { applyValidationSessionTablesMigration } from '../db/migrations/validation-session-tables.js';
import { applyAgentActivityValidationColumnsMigration } from '../db/migrations/agent-activity-validation-columns.js';
import {
  guardJsonSize,
  SCHEMA_VERSION,
  type CreateValidationSessionInput,
  type ValidationSessionRow,
  type SaveValidationMetricInput,
  type ValidationMetricRow,
  type AgentValidationStateRow,
  type UpdateValidationStateInput,
  type ValidationSessionDetail,
} from './types.js';

// ── Table Init ──────────────────────────────────────────────────────────────

export function initValidationTables(db: SQLiteDatabase): void {
  applyValidationSessionTablesMigration(db);
  migrateAgentActivity(db);
}

// ── agent_activity Migration ────────────────────────────────────────────────

function migrateAgentActivity(db: SQLiteDatabase): void {
  applyAgentActivityValidationColumnsMigration(db);
}

// ── Validation Session CRUD ─────────────────────────────────────────────────

export function createValidationSession(
  db: SQLiteDatabase,
  input: CreateValidationSessionInput
): ValidationSessionRow {
  db.prepare(
    `INSERT INTO validation_sessions
       (id, agent_id, agent_version, trigger_type, goal, metric_profile_json,
        baseline_version, baseline_session_id, execution_status, validation_outcome,
        summary, recommendation, before_snapshot_json, after_snapshot_json,
        report_json, schema_version, requires_approval, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.agent_id,
    input.agent_version,
    input.trigger_type,
    input.goal ?? null,
    input.metric_profile_json,
    input.baseline_version ?? null,
    input.baseline_session_id ?? null,
    input.execution_status,
    input.validation_outcome,
    input.summary ?? null,
    input.recommendation ?? null,
    guardJsonSize(input.before_snapshot_json),
    guardJsonSize(input.after_snapshot_json),
    guardJsonSize(input.report_json),
    input.schema_version ?? SCHEMA_VERSION,
    input.requires_approval ?? 0,
    input.started_at,
    input.ended_at ?? null
  );
  return db
    .prepare('SELECT * FROM validation_sessions WHERE id = ?')
    .get(input.id) as ValidationSessionRow;
}

export function updateValidationSession(
  db: SQLiteDatabase,
  id: string,
  updates: Partial<
    Pick<
      CreateValidationSessionInput,
      | 'execution_status'
      | 'validation_outcome'
      | 'summary'
      | 'recommendation'
      | 'after_snapshot_json'
      | 'report_json'
      | 'ended_at'
    >
  >
): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.execution_status !== undefined) {
    setClauses.push('execution_status = ?');
    values.push(updates.execution_status);
  }
  if (updates.validation_outcome !== undefined) {
    setClauses.push('validation_outcome = ?');
    values.push(updates.validation_outcome);
  }
  if (updates.summary !== undefined) {
    setClauses.push('summary = ?');
    values.push(updates.summary);
  }
  if (updates.recommendation !== undefined) {
    setClauses.push('recommendation = ?');
    values.push(updates.recommendation);
  }
  if (updates.after_snapshot_json !== undefined) {
    setClauses.push('after_snapshot_json = ?');
    values.push(guardJsonSize(updates.after_snapshot_json));
  }
  if (updates.report_json !== undefined) {
    setClauses.push('report_json = ?');
    values.push(guardJsonSize(updates.report_json));
  }
  if (updates.ended_at !== undefined) {
    setClauses.push('ended_at = ?');
    values.push(updates.ended_at);
  }

  if (setClauses.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE validation_sessions SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

// ── Validation Metrics ──────────────────────────────────────────────────────

export function saveValidationMetric(db: SQLiteDatabase, input: SaveValidationMetricInput): void {
  db.prepare(
    `INSERT INTO validation_metrics
       (validation_session_id, name, value, baseline_value, delta_value, direction, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.validation_session_id,
    input.name,
    input.value,
    input.baseline_value ?? null,
    input.delta_value ?? null,
    input.direction,
    Date.now()
  );
}

// ── Query: Summary ──────────────────────────────────────────────────────────

export function getValidationSummary(
  db: SQLiteDatabase,
  agentId: string
): ValidationSessionRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM validation_sessions
         WHERE agent_id = ?
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(agentId) as ValidationSessionRow | undefined) ?? null
  );
}

// ── Query: History ──────────────────────────────────────────────────────────

export function listValidationHistory(
  db: SQLiteDatabase,
  agentId: string,
  limit = 50
): ValidationSessionRow[] {
  return db
    .prepare(
      `SELECT * FROM validation_sessions
       WHERE agent_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(agentId, limit) as ValidationSessionRow[];
}

// ── Query: Session Detail ───────────────────────────────────────────────────

export function getValidationSessionDetail(
  db: SQLiteDatabase,
  sessionId: string
): ValidationSessionDetail | null {
  const session = db.prepare('SELECT * FROM validation_sessions WHERE id = ?').get(sessionId) as
    | ValidationSessionRow
    | undefined;

  if (!session) return null;

  const metrics = db
    .prepare('SELECT * FROM validation_metrics WHERE validation_session_id = ? ORDER BY created_at')
    .all(sessionId) as ValidationMetricRow[];

  return { session, metrics };
}

// ── Approval ────────────────────────────────────────────────────────────────

export function approveValidationSession(db: SQLiteDatabase, sessionId: string): void {
  const session = db.prepare('SELECT * FROM validation_sessions WHERE id = ?').get(sessionId) as
    | ValidationSessionRow
    | undefined;

  if (!session) return;

  updateAgentValidationState(db, session.agent_id, session.trigger_type, {
    approved_version: session.agent_version,
    approved_session_id: session.id,
    current_status: session.validation_outcome,
    last_validation_at: Date.now(),
  });
}

// ── Agent Validation State ──────────────────────────────────────────────────

export function getAgentValidationState(
  db: SQLiteDatabase,
  agentId: string,
  triggerType: string
): AgentValidationStateRow | null {
  return (
    (db
      .prepare('SELECT * FROM agent_validation_state WHERE agent_id = ? AND trigger_type = ?')
      .get(agentId, triggerType) as AgentValidationStateRow | undefined) ?? null
  );
}

export function updateAgentValidationState(
  db: SQLiteDatabase,
  agentId: string,
  triggerType: string,
  input: UpdateValidationStateInput
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_validation_state
       (agent_id, trigger_type, approved_version, approved_session_id, current_status, last_validation_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, trigger_type) DO UPDATE SET
       approved_version = COALESCE(excluded.approved_version, approved_version),
       approved_session_id = COALESCE(excluded.approved_session_id, approved_session_id),
       current_status = COALESCE(excluded.current_status, current_status),
       last_validation_at = COALESCE(excluded.last_validation_at, last_validation_at),
       updated_at = excluded.updated_at`
  ).run(
    agentId,
    triggerType,
    input.approved_version ?? null,
    input.approved_session_id ?? null,
    input.current_status ?? null,
    input.last_validation_at ?? null,
    now
  );
}

// ── Stale Session Cleanup ───────────────────────────────────────────────────

export function listStaleSessions(db: SQLiteDatabase, maxAgeMs: number): ValidationSessionRow[] {
  const cutoff = Date.now() - maxAgeMs;
  return db
    .prepare(
      `SELECT * FROM validation_sessions
       WHERE ended_at IS NULL AND started_at < ?
       ORDER BY started_at ASC`
    )
    .all(cutoff) as ValidationSessionRow[];
}

// ── Baseline Lookup ─────────────────────────────────────────────────────────

export function findBaseline(
  db: SQLiteDatabase,
  agentId: string,
  triggerType: string
): { version: number; sessionId: string } | null {
  // 1. approved session
  const state = getAgentValidationState(db, agentId, triggerType);
  if (state?.approved_session_id && state.approved_version !== null) {
    return { version: state.approved_version, sessionId: state.approved_session_id };
  }

  // 2. last healthy session
  const healthy = db
    .prepare(
      `SELECT id, agent_version FROM validation_sessions
       WHERE agent_id = ? AND trigger_type = ? AND validation_outcome = 'healthy'
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(agentId, triggerType) as { id: string; agent_version: number } | undefined;
  if (healthy) {
    return { version: healthy.agent_version, sessionId: healthy.id };
  }

  // 3. last completed session
  const completed = db
    .prepare(
      `SELECT id, agent_version FROM validation_sessions
       WHERE agent_id = ? AND trigger_type = ? AND execution_status = 'completed'
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(agentId, triggerType) as { id: string; agent_version: number } | undefined;
  if (completed) {
    return { version: completed.agent_version, sessionId: completed.id };
  }

  // 4. no baseline → inconclusive
  return null;
}
