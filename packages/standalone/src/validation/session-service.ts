/**
 * Validation Session Service
 *
 * Orchestrates the validation session lifecycle:
 *   startSession → recordRun → finalizeSession
 *
 * Includes snapshot building (API-only, no DOM),
 * metric computation, status classification, and stale session cleanup.
 */

import { randomUUID } from 'crypto';
import type { SQLiteDatabase } from '../sqlite.js';
import {
  createValidationSession,
  updateValidationSession,
  saveValidationMetric,
  getValidationSessionDetail,
  findBaseline,
  listStaleSessions,
  updateAgentValidationState,
} from './store.js';
import {
  getMetricProfile,
  guardJsonSize,
  SCHEMA_VERSION,
  type ValidationSessionRow,
  type ValidationTriggerType,
  type ExecutionStatus,
  type ValidationOutcome,
  type MetricDirection,
  type ValidationMetricRow,
} from './types.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface RecordRunInput {
  activityId?: number;
  duration_ms?: number;
  tokens_used?: number;
  tools_called?: string[];
  error_message?: string;
}

export interface FinalizeInput {
  execution_status: ExecutionStatus;
  metrics?: Record<string, number>;
  error_message?: string;
  test_input_summary?: string;
}

interface StartSessionOptions {
  goal?: string;
  customBeforeSnapshot?: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class ValidationSessionService {
  constructor(private db: SQLiteDatabase) {}

  /**
   * Start a new validation session.
   * Captures before snapshot, looks up baseline, creates DB row.
   */
  startSession(
    agentId: string,
    agentVersion: number,
    triggerType: ValidationTriggerType,
    options?: StartSessionOptions
  ): ValidationSessionRow {
    const sessionId = `vs-${randomUUID().slice(0, 8)}-${Date.now()}`;
    const profile = getMetricProfile(agentId);

    // Baseline lookup
    const baseline = findBaseline(this.db, agentId, triggerType);

    // Before snapshot (API state summary)
    const beforeSnapshot = options?.customBeforeSnapshot ?? this.buildBeforeSnapshot(agentId);

    return createValidationSession(this.db, {
      id: sessionId,
      agent_id: agentId,
      agent_version: agentVersion,
      trigger_type: triggerType,
      goal: options?.goal,
      metric_profile_json: JSON.stringify(profile),
      baseline_version: baseline?.version,
      baseline_session_id: baseline?.sessionId,
      execution_status: 'started',
      validation_outcome: 'inconclusive',
      before_snapshot_json: guardJsonSize(beforeSnapshot),
      started_at: Date.now(),
    });
  }

  /**
   * Record a run envelope. Links an activity row to this session via run_id.
   */
  recordRun(sessionId: string, input: RecordRunInput): void {
    if (input.activityId) {
      this.db
        .prepare('UPDATE agent_activity SET run_id = ? WHERE id = ?')
        .run(sessionId, input.activityId);
    }
  }

  /**
   * Finalize a session: capture after snapshot, compute metrics,
   * classify status, update validation state.
   */
  finalizeSession(sessionId: string, input: FinalizeInput): ValidationSessionRow {
    const detail = getValidationSessionDetail(this.db, sessionId);
    if (!detail) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const session = detail.session;

    // If execution failed, mark inconclusive
    if (input.execution_status === 'failed' || input.execution_status === 'timeout') {
      updateValidationSession(this.db, sessionId, {
        execution_status: input.execution_status,
        validation_outcome: 'inconclusive',
        summary: input.error_message ?? `Execution ${input.execution_status}`,
        after_snapshot_json: this.buildAfterSnapshot(session.agent_id, input),
        ended_at: Date.now(),
      });
      this.updateState(session.agent_id, session.trigger_type, 'inconclusive');
      return this.getSession(sessionId);
    }

    // Compute metrics and deltas against baseline
    const profile = JSON.parse(session.metric_profile_json);
    const baselineMetrics = this.loadBaselineMetrics(session.baseline_session_id);
    let outcome: ValidationOutcome = 'inconclusive';

    if (input.metrics && Object.keys(input.metrics).length > 0) {
      const { hasImprovement, hasRegression } = this.saveMetricsWithDelta(
        sessionId,
        input.metrics,
        baselineMetrics,
        profile
      );

      outcome = this.classifyOutcome(input.metrics, profile, hasImprovement, hasRegression);
    }

    // Build after snapshot
    const afterSnapshot = this.buildAfterSnapshot(session.agent_id, input);

    // Build report
    const report = this.buildReport(session, input, outcome);

    updateValidationSession(this.db, sessionId, {
      execution_status: 'completed',
      validation_outcome: outcome,
      after_snapshot_json: afterSnapshot,
      report_json: report,
      summary: `${outcome}: ${Object.keys(input.metrics ?? {}).length} metrics evaluated`,
      ended_at: Date.now(),
    });

    this.updateState(session.agent_id, session.trigger_type, outcome);
    return this.getSession(sessionId);
  }

  /**
   * Clean up stale sessions (started but never ended).
   * Returns count of cleaned sessions.
   */
  cleanupStaleSessions(maxAgeMs: number): number {
    const stale = listStaleSessions(this.db, maxAgeMs);
    for (const session of stale) {
      updateValidationSession(this.db, session.id, {
        execution_status: 'timeout',
        validation_outcome: 'inconclusive',
        summary: 'Session timed out (stale cleanup)',
        ended_at: Date.now(),
      });
    }
    return stale.length;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private getSession(id: string): ValidationSessionRow {
    const detail = getValidationSessionDetail(this.db, id);
    if (!detail) throw new Error(`Session ${id} not found`);
    return detail.session;
  }

  private buildBeforeSnapshot(agentId: string): string {
    // Capture API-level state summary from DB
    const activityCount =
      (
        this.db
          .prepare('SELECT COUNT(*) as cnt FROM agent_activity WHERE agent_id = ?')
          .get(agentId) as { cnt: number } | undefined
      )?.cnt ?? 0;

    const latestActivity = this.db
      .prepare(
        'SELECT type, score, created_at FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(agentId) as { type: string; score: number | null; created_at: string } | undefined;

    return JSON.stringify({
      schema_version: SCHEMA_VERSION,
      agent_id: agentId,
      activity_count: activityCount,
      latest_activity_type: latestActivity?.type ?? null,
      latest_score: latestActivity?.score ?? null,
      captured_at: Date.now(),
    });
  }

  private buildAfterSnapshot(agentId: string, input: FinalizeInput): string {
    const base = JSON.parse(this.buildBeforeSnapshot(agentId));
    return JSON.stringify({
      ...base,
      execution_status: input.execution_status,
      error_message: input.error_message ?? null,
      test_input_summary: input.test_input_summary ?? null,
    });
  }

  private loadBaselineMetrics(baselineSessionId: string | null): Map<string, ValidationMetricRow> {
    const map = new Map<string, ValidationMetricRow>();
    if (!baselineSessionId) return map;

    const detail = getValidationSessionDetail(this.db, baselineSessionId);
    if (!detail) return map;

    for (const m of detail.metrics) {
      map.set(m.name, m);
    }
    return map;
  }

  private saveMetricsWithDelta(
    sessionId: string,
    metrics: Record<string, number>,
    baselineMetrics: Map<string, ValidationMetricRow>,
    _profile: { thresholds?: Record<string, { warn: number; critical: number }> }
  ): { hasImprovement: boolean; hasRegression: boolean } {
    let hasImprovement = false;
    let hasRegression = false;

    for (const [name, value] of Object.entries(metrics)) {
      const direction = this.inferDirection(name);
      const baselineMetric = baselineMetrics.get(name);
      const baselineValue = baselineMetric?.value ?? null;
      let deltaValue: number | null = null;

      if (baselineValue !== null) {
        deltaValue = value - baselineValue;

        // Check if improved or regressed
        if (direction === 'down_good') {
          if (deltaValue < 0) hasImprovement = true;
          if (deltaValue > 0) hasRegression = true;
        } else if (direction === 'up_good') {
          if (deltaValue > 0) hasImprovement = true;
          if (deltaValue < 0) hasRegression = true;
        }
      }

      saveValidationMetric(this.db, {
        validation_session_id: sessionId,
        name,
        value,
        baseline_value: baselineValue,
        delta_value: deltaValue,
        direction,
      });
    }

    return { hasImprovement, hasRegression };
  }

  private classifyOutcome(
    metrics: Record<string, number>,
    profile: { thresholds?: Record<string, { warn: number; critical: number }> },
    hasImprovement: boolean,
    hasRegression: boolean
  ): ValidationOutcome {
    // Check critical thresholds
    if (profile.thresholds) {
      for (const [name, threshold] of Object.entries(profile.thresholds)) {
        const value = metrics[name];
        if (value !== undefined && value >= threshold.critical) {
          return 'regressed';
        }
      }
    }

    if (hasRegression) return 'regressed';
    if (hasImprovement) return 'improved';
    return 'healthy';
  }

  private inferDirection(metricName: string): MetricDirection {
    // Metrics where lower is better
    if (
      metricName.includes('latency') ||
      metricName.includes('duration') ||
      metricName.includes('cost') ||
      metricName.includes('error') ||
      metricName.includes('meaningless') ||
      metricName.includes('staleness')
    ) {
      return 'down_good';
    }
    // Metrics where higher is better
    if (
      metricName.includes('rate') ||
      metricName.includes('efficiency') ||
      metricName.includes('accuracy') ||
      metricName.includes('signal')
    ) {
      return 'up_good';
    }
    return 'neutral';
  }

  private buildReport(
    session: ValidationSessionRow,
    input: FinalizeInput,
    outcome: ValidationOutcome
  ): string {
    const lines: string[] = [
      `${session.agent_id} validation: ${outcome}`,
      `trigger: ${session.trigger_type}`,
      `version: ${session.agent_version}`,
    ];

    if (input.metrics) {
      for (const [name, value] of Object.entries(input.metrics)) {
        lines.push(`  ${name}: ${value}`);
      }
    }

    if (input.error_message) {
      lines.push(`error: ${input.error_message}`);
    }

    return JSON.stringify({
      schema_version: SCHEMA_VERSION,
      headline: `${session.agent_id}: ${outcome}`,
      what_changed: input.metrics ? Object.keys(input.metrics).join(', ') : 'no metrics',
      outcome,
      details: lines.join('\n'),
    });
  }

  private updateState(agentId: string, triggerType: string, outcome: string): void {
    updateAgentValidationState(this.db, agentId, triggerType, {
      current_status: outcome,
      last_validation_at: Date.now(),
    });
  }
}
