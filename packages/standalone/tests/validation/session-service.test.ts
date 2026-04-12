import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import { initAgentTables, logActivity } from '../../src/db/agent-store.js';
import {
  initValidationTables,
  getValidationSessionDetail,
  approveValidationSession,
  createValidationSession,
  saveValidationMetric,
} from '../../src/validation/store.js';
import { ValidationSessionService } from '../../src/validation/session-service.js';
import { getMetricProfile } from '../../src/validation/types.js';

describe('ValidationSessionService', () => {
  let db: InstanceType<typeof Database>;
  let service: ValidationSessionService;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
    initValidationTables(db);
    service = new ValidationSessionService(db);
  });

  describe('startSession', () => {
    it('creates a session with execution_status=started', () => {
      const session = service.startSession('wiki-agent', 1, 'agent_test');
      expect(session.execution_status).toBe('started');
      expect(session.validation_outcome).toBe('inconclusive');
      expect(session.agent_id).toBe('wiki-agent');
    });

    it('captures before snapshot', () => {
      const session = service.startSession('wiki-agent', 1, 'agent_test');
      expect(session.before_snapshot_json).not.toBeNull();
      const snap = JSON.parse(session.before_snapshot_json!);
      expect(snap.schema_version).toBe(1);
    });

    it('looks up baseline and attaches to session', () => {
      // Create an approved baseline first
      createValidationSession(db, {
        id: 'baseline-1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: JSON.stringify(getMetricProfile('wiki-agent')),
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: Date.now() - 5000,
        ended_at: Date.now() - 4000,
      });
      approveValidationSession(db, 'baseline-1');

      const session = service.startSession('wiki-agent', 2, 'agent_test');
      expect(session.baseline_session_id).toBe('baseline-1');
      expect(session.baseline_version).toBe(1);
    });
  });

  describe('recordRun', () => {
    it('links activity row to session via run_id', () => {
      const session = service.startSession('wiki-agent', 1, 'delegate_run');
      const activityRow = logActivity(db, {
        agent_id: 'wiki-agent',
        agent_version: 1,
        type: 'task_complete',
        duration_ms: 1500,
        tokens_used: 800,
      });

      service.recordRun(session.id, {
        activityId: activityRow.id,
        duration_ms: 1500,
        tokens_used: 800,
        tools_called: ['mama_search'],
      });

      // Verify run_id was set on the activity row
      const updated = db
        .prepare('SELECT run_id FROM agent_activity WHERE id = ?')
        .get(activityRow.id) as { run_id: string | null };
      expect(updated.run_id).toBe(session.id);
    });
  });

  describe('finalizeSession', () => {
    it('marks completed session as healthy when no thresholds violated', () => {
      const session = service.startSession('wiki-agent', 1, 'agent_test');

      service.recordRun(session.id, {
        duration_ms: 2000,
        tokens_used: 500,
      });

      const finalized = service.finalizeSession(session.id, {
        execution_status: 'completed',
        metrics: {
          publish_latency_ms: 2000,
          token_cost: 500,
          meaningless_run_rate: 0.1,
        },
      });

      expect(finalized.execution_status).toBe('completed');
      expect(finalized.validation_outcome).toBe('healthy');
      expect(finalized.after_snapshot_json).not.toBeNull();
      expect(finalized.ended_at).not.toBeNull();
    });

    it('marks as regressed when critical threshold exceeded', () => {
      const session = service.startSession('wiki-agent', 1, 'agent_test');

      const finalized = service.finalizeSession(session.id, {
        execution_status: 'completed',
        metrics: {
          publish_latency_ms: 70_000, // > 60000 critical
          token_cost: 500,
        },
      });

      expect(finalized.validation_outcome).toBe('regressed');
    });

    it('marks as inconclusive when execution failed', () => {
      const session = service.startSession('wiki-agent', 1, 'system_run');

      const finalized = service.finalizeSession(session.id, {
        execution_status: 'failed',
        error_message: 'process crashed',
      });

      expect(finalized.execution_status).toBe('failed');
      expect(finalized.validation_outcome).toBe('inconclusive');
    });

    it('marks as improved when metrics better than baseline', () => {
      // Create baseline
      createValidationSession(db, {
        id: 'bl-improve',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: JSON.stringify(getMetricProfile('wiki-agent')),
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: Date.now() - 5000,
        ended_at: Date.now() - 4000,
      });
      approveValidationSession(db, 'bl-improve');

      // Save baseline metrics
      saveValidationMetric(db, {
        validation_session_id: 'bl-improve',
        name: 'publish_latency_ms',
        value: 5000,
        direction: 'down_good',
      });

      // Start new session with baseline
      const session = service.startSession('wiki-agent', 2, 'agent_test');

      const finalized = service.finalizeSession(session.id, {
        execution_status: 'completed',
        metrics: {
          publish_latency_ms: 2000, // improved from 5000
          token_cost: 300,
        },
      });

      expect(finalized.validation_outcome).toBe('improved');

      // Verify metrics were saved with delta
      const detail = getValidationSessionDetail(db, session.id);
      const latencyMetric = detail!.metrics.find((m) => m.name === 'publish_latency_ms');
      expect(latencyMetric).toBeDefined();
      expect(latencyMetric!.delta_value).toBeLessThan(0); // negative = improvement for down_good
    });

    it('rejects invalid finalize payload metrics', () => {
      const session = service.startSession('wiki-agent', 1, 'agent_test');

      expect(() =>
        service.finalizeSession(session.id, {
          execution_status: 'completed',
          metrics: { publish_latency_ms: Number.NaN },
        })
      ).toThrow('Invalid validation metrics payload');
    });

    it('rejects non-terminal finalize statuses', () => {
      const session = service.startSession('wiki-agent', 1, 'agent_test');

      expect(() =>
        service.finalizeSession(session.id, {
          execution_status: 'started',
        })
      ).toThrow('Invalid execution status');
    });
  });

  describe('classifyStatus', () => {
    it('returns inconclusive when no metrics provided', () => {
      const session = service.startSession('wiki-agent', 1, 'agent_test');
      const finalized = service.finalizeSession(session.id, {
        execution_status: 'completed',
      });
      expect(finalized.validation_outcome).toBe('inconclusive');
    });
  });

  describe('concurrent sessions', () => {
    it('allows two sessions for the same agent simultaneously', () => {
      const s1 = service.startSession('wiki-agent', 1, 'agent_test');
      const s2 = service.startSession('wiki-agent', 1, 'delegate_run');

      expect(s1.id).not.toBe(s2.id);

      const f1 = service.finalizeSession(s1.id, {
        execution_status: 'completed',
        metrics: { publish_latency_ms: 2000 },
      });
      const f2 = service.finalizeSession(s2.id, {
        execution_status: 'completed',
        metrics: { publish_latency_ms: 3000 },
      });

      expect(f1.validation_outcome).not.toBeUndefined();
      expect(f2.validation_outcome).not.toBeUndefined();
    });
  });

  describe('partial session cleanup', () => {
    it('marks stale sessions as inconclusive', () => {
      // Create a stale session (started 10 minutes ago, never ended)
      createValidationSession(db, {
        id: 'stale-1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'system_run',
        metric_profile_json: '{}',
        execution_status: 'started',
        validation_outcome: 'inconclusive',
        started_at: Date.now() - 600_000,
      });

      const cleaned = service.cleanupStaleSessions(300_000);
      expect(cleaned).toBe(1);

      const detail = getValidationSessionDetail(db, 'stale-1');
      expect(detail!.session.execution_status).toBe('timeout');
      expect(detail!.session.validation_outcome).toBe('inconclusive');
      expect(detail!.session.ended_at).not.toBeNull();
    });

    it('refreshes validation state when stale sessions are cleaned', () => {
      createValidationSession(db, {
        id: 'stale-2',
        agent_id: 'wiki-agent',
        agent_version: 2,
        trigger_type: 'system_run',
        metric_profile_json: '{}',
        execution_status: 'started',
        validation_outcome: 'inconclusive',
        started_at: Date.now() - 600_000,
      });

      service.cleanupStaleSessions(300_000);

      const state = db
        .prepare(
          'SELECT current_status, last_validation_at FROM agent_validation_state WHERE agent_id = ? AND trigger_type = ?'
        )
        .get('wiki-agent', 'system_run') as {
        current_status: string | null;
        last_validation_at: number | null;
      };

      expect(state.current_status).toBe('inconclusive');
      expect(state.last_validation_at).not.toBeNull();
    });
  });

  describe('JSON size guard', () => {
    it('truncates oversized snapshot JSON', () => {
      const bigJson = JSON.stringify({ data: 'x'.repeat(60_000) });
      const session = service.startSession('wiki-agent', 1, 'agent_test', {
        customBeforeSnapshot: bigJson,
      });
      expect(session.before_snapshot_json!.length).toBeLessThanOrEqual(50 * 1024);
    });
  });
});
