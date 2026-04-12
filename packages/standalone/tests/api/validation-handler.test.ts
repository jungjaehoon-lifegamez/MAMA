/**
 * Validation API tests — tests the store functions that graph-api.ts routes call directly.
 * (graph-api.ts uses require() to call store functions, not Express handlers)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import {
  initValidationTables,
  createValidationSession,
  saveValidationMetric,
  approveValidationSession,
  getValidationSummary,
  listValidationHistory,
  getValidationSessionDetail,
  getAgentValidationState,
} from '../../src/validation/store.js';

describe('Validation API (store-level)', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
    initValidationTables(db);
  });

  describe('GET /api/agents/:id/validation/summary', () => {
    it('returns null for nonexistent agent', () => {
      const summary = getValidationSummary(db, 'nonexistent');
      expect(summary).toBeNull();
    });

    it('returns latest session for existing agent', () => {
      createValidationSession(db, {
        id: 'vs-api-1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: Date.now(),
        ended_at: Date.now(),
      });

      const summary = getValidationSummary(db, 'wiki-agent');
      expect(summary).not.toBeNull();
      expect(summary!.validation_outcome).toBe('healthy');
    });
  });

  describe('GET /api/agents/:id/validation/history', () => {
    it('returns empty array when no sessions', () => {
      const history = listValidationHistory(db, 'wiki-agent');
      expect(history).toEqual([]);
    });

    it('returns sessions ordered by most recent', () => {
      const now = Date.now();
      createValidationSession(db, {
        id: 'vh-1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: now - 2000,
        ended_at: now - 1000,
      });
      createValidationSession(db, {
        id: 'vh-2',
        agent_id: 'wiki-agent',
        agent_version: 2,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'improved',
        started_at: now - 500,
        ended_at: now,
      });

      const history = listValidationHistory(db, 'wiki-agent');
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('vh-2');
    });
  });

  describe('GET /api/validation-sessions/:id', () => {
    it('returns null for nonexistent session', () => {
      const detail = getValidationSessionDetail(db, 'nonexistent');
      expect(detail).toBeNull();
    });

    it('returns session with metrics', () => {
      createValidationSession(db, {
        id: 'vd-1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: Date.now(),
      });
      saveValidationMetric(db, {
        validation_session_id: 'vd-1',
        name: 'duration_ms',
        value: 2000,
        direction: 'down_good',
      });

      const detail = getValidationSessionDetail(db, 'vd-1');
      expect(detail).not.toBeNull();
      expect(detail!.session.id).toBe('vd-1');
      expect(detail!.metrics).toHaveLength(1);
    });
  });

  describe('GET /api/agents/:id/validation/compare', () => {
    it('computes deltas between current and baseline', () => {
      const now = Date.now();
      // Create baseline
      createValidationSession(db, {
        id: 'vc-base',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: now - 5000,
        ended_at: now - 4000,
      });
      saveValidationMetric(db, {
        validation_session_id: 'vc-base',
        name: 'duration_ms',
        value: 3000,
        direction: 'down_good',
      });
      approveValidationSession(db, 'vc-base');

      // Create current
      createValidationSession(db, {
        id: 'vc-current',
        agent_id: 'wiki-agent',
        agent_version: 2,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'improved',
        started_at: now - 1000,
        ended_at: now,
      });
      saveValidationMetric(db, {
        validation_session_id: 'vc-current',
        name: 'duration_ms',
        value: 2000,
        direction: 'down_good',
      });

      // Simulate compare: get current + baseline + compute deltas
      const current = getValidationSessionDetail(db, 'vc-current')!;
      const state = getAgentValidationState(db, 'wiki-agent', 'agent_test');
      const baseline = getValidationSessionDetail(db, state!.approved_session_id!)!;

      const baselineMetrics = new Map(baseline.metrics.map((m) => [m.name, m.value]));
      const deltas = current.metrics.map((m) => ({
        name: m.name,
        current: m.value,
        baseline: baselineMetrics.get(m.name) ?? null,
        delta: baselineMetrics.has(m.name) ? m.value - baselineMetrics.get(m.name)! : null,
      }));

      expect(deltas[0].delta).toBe(-1000); // improved
    });
  });

  describe('POST /api/agents/:id/validation/approve', () => {
    it('approves a session and updates state', () => {
      createValidationSession(db, {
        id: 'va-1',
        agent_id: 'wiki-agent',
        agent_version: 3,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'improved',
        started_at: Date.now() - 1000,
        ended_at: Date.now(),
      });

      approveValidationSession(db, 'va-1');

      const state = getAgentValidationState(db, 'wiki-agent', 'agent_test');
      expect(state).not.toBeNull();
      expect(state!.approved_version).toBe(3);
      expect(state!.approved_session_id).toBe('va-1');
    });
  });
});
