import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import {
  initValidationTables,
  createValidationSession,
  saveValidationMetric,
  getValidationSummary,
  listValidationHistory,
  getValidationSessionDetail,
  approveValidationSession,
  getAgentValidationState,
  updateAgentValidationState,
  listStaleSessions,
} from '../../src/validation/store.js';
import type {
  CreateValidationSessionInput,
  SaveValidationMetricInput,
} from '../../src/validation/types.js';

describe('Validation Store', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
    initValidationTables(db);
  });

  describe('initValidationTables', () => {
    it('creates validation_sessions table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='validation_sessions'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('creates validation_metrics table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='validation_metrics'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('creates agent_validation_state table', () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_validation_state'"
        )
        .all();
      expect(tables).toHaveLength(1);
    });

    it('is idempotent', () => {
      expect(() => initValidationTables(db)).not.toThrow();
    });

    it('does not require agent_activity to exist before validation bootstrap', () => {
      const isolatedDb = new Database(':memory:');
      expect(() => initValidationTables(isolatedDb)).not.toThrow();
    });
  });

  describe('agent_activity migration', () => {
    it('adds run_id column to agent_activity', () => {
      const cols = db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{
        name: string;
      }>;
      expect(cols.some((c) => c.name === 'run_id')).toBe(true);
    });

    it('adds execution_status column to agent_activity', () => {
      const cols = db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{
        name: string;
      }>;
      expect(cols.some((c) => c.name === 'execution_status')).toBe(true);
    });

    it('adds trigger_reason column to agent_activity', () => {
      const cols = db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{
        name: string;
      }>;
      expect(cols.some((c) => c.name === 'trigger_reason')).toBe(true);
    });
  });

  describe('createValidationSession', () => {
    it('creates a session and returns it', () => {
      const input: CreateValidationSessionInput = {
        id: 'vs-001',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'started',
        validation_outcome: 'inconclusive',
        started_at: Date.now(),
      };
      const session = createValidationSession(db, input);
      expect(session.id).toBe('vs-001');
      expect(session.agent_id).toBe('wiki-agent');
      expect(session.execution_status).toBe('started');
      expect(session.validation_outcome).toBe('inconclusive');
    });

    it('stores before/after snapshots as JSON columns', () => {
      const input: CreateValidationSessionInput = {
        id: 'vs-002',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'delegate_run',
        metric_profile_json: '{}',
        execution_status: 'started',
        validation_outcome: 'inconclusive',
        before_snapshot_json: JSON.stringify({ activity_count: 5 }),
        started_at: Date.now(),
      };
      const session = createValidationSession(db, input);
      expect(session.before_snapshot_json).toBe(JSON.stringify({ activity_count: 5 }));
    });
  });

  describe('saveValidationMetric', () => {
    it('saves metrics for a session', () => {
      createValidationSession(db, {
        id: 'vs-m1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: Date.now(),
      });

      const metric: SaveValidationMetricInput = {
        validation_session_id: 'vs-m1',
        name: 'publish_latency_ms',
        value: 2400,
        baseline_value: 3000,
        delta_value: -600,
        direction: 'down_good',
      };
      saveValidationMetric(db, metric);

      const detail = getValidationSessionDetail(db, 'vs-m1');
      expect(detail).not.toBeNull();
      expect(detail!.metrics).toHaveLength(1);
      expect(detail!.metrics[0].name).toBe('publish_latency_ms');
      expect(detail!.metrics[0].delta_value).toBe(-600);
    });
  });

  describe('getValidationSummary', () => {
    it('returns null for agent with no sessions', () => {
      const summary = getValidationSummary(db, 'nonexistent');
      expect(summary).toBeNull();
    });

    it('returns latest session info', () => {
      createValidationSession(db, {
        id: 'vs-s1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: Date.now() - 1000,
        ended_at: Date.now(),
      });
      const summary = getValidationSummary(db, 'wiki-agent');
      expect(summary).not.toBeNull();
      expect(summary!.validation_outcome).toBe('healthy');
    });
  });

  describe('listValidationHistory', () => {
    it('returns sessions ordered by started_at desc', () => {
      const now = Date.now();
      createValidationSession(db, {
        id: 'vs-h1',
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
        id: 'vs-h2',
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
      expect(history[0].id).toBe('vs-h2');
      expect(history[1].id).toBe('vs-h1');
    });
  });

  describe('approveValidationSession', () => {
    it('updates agent_validation_state', () => {
      createValidationSession(db, {
        id: 'vs-a1',
        agent_id: 'wiki-agent',
        agent_version: 3,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'improved',
        started_at: Date.now() - 1000,
        ended_at: Date.now(),
      });

      approveValidationSession(db, 'vs-a1');

      const state = getAgentValidationState(db, 'wiki-agent', 'agent_test');
      expect(state).not.toBeNull();
      expect(state!.approved_version).toBe(3);
      expect(state!.approved_session_id).toBe('vs-a1');
    });

    it('throws when approving a missing session', () => {
      expect(() => approveValidationSession(db, 'missing-session')).toThrow('missing-session');
    });
  });

  describe('agent_validation_state with composite PK', () => {
    it('tracks state per trigger_type independently', () => {
      createValidationSession(db, {
        id: 'vs-pk1',
        agent_id: 'wiki-agent',
        agent_version: 2,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: Date.now(),
      });
      createValidationSession(db, {
        id: 'vs-pk2',
        agent_id: 'wiki-agent',
        agent_version: 2,
        trigger_type: 'delegate_run',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'regressed',
        started_at: Date.now(),
      });

      updateAgentValidationState(db, 'wiki-agent', 'agent_test', {
        current_status: 'healthy',
        last_validation_at: Date.now(),
      });
      updateAgentValidationState(db, 'wiki-agent', 'delegate_run', {
        current_status: 'regressed',
        last_validation_at: Date.now(),
      });

      const testState = getAgentValidationState(db, 'wiki-agent', 'agent_test');
      const delegateState = getAgentValidationState(db, 'wiki-agent', 'delegate_run');

      expect(testState!.current_status).toBe('healthy');
      expect(delegateState!.current_status).toBe('regressed');
    });
  });

  describe('baseline selection', () => {
    it('finds approved session first', () => {
      const now = Date.now();
      createValidationSession(db, {
        id: 'vs-bl1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: now - 3000,
        ended_at: now - 2000,
      });
      approveValidationSession(db, 'vs-bl1');

      createValidationSession(db, {
        id: 'vs-bl2',
        agent_id: 'wiki-agent',
        agent_version: 2,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'completed',
        validation_outcome: 'healthy',
        started_at: now - 1000,
        ended_at: now,
      });

      const state = getAgentValidationState(db, 'wiki-agent', 'agent_test');
      expect(state!.approved_session_id).toBe('vs-bl1');
    });
  });

  describe('stale session cleanup', () => {
    it('lists sessions with ended_at IS NULL', () => {
      createValidationSession(db, {
        id: 'vs-stale1',
        agent_id: 'wiki-agent',
        agent_version: 1,
        trigger_type: 'agent_test',
        metric_profile_json: '{}',
        execution_status: 'started',
        validation_outcome: 'inconclusive',
        started_at: Date.now() - 600_000,
      });

      const stale = listStaleSessions(db, 300_000);
      expect(stale.length).toBeGreaterThanOrEqual(1);
      expect(stale[0].id).toBe('vs-stale1');
    });
  });
});
