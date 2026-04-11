import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import {
  initValidationTables,
  createValidationSession,
  saveValidationMetric,
  approveValidationSession,
} from '../../src/validation/store.js';
import {
  handleValidationSummary,
  handleValidationHistory,
  handleValidationSessionDetail,
  handleValidationCompare,
  handleValidationApprove,
} from '../../src/api/validation-handler.js';

// Minimal mock for Express req/res
function mockReq(
  params: Record<string, string> = {},
  query: Record<string, string> = {}
): { params: Record<string, string>; query: Record<string, string> } {
  return { params, query };
}

function mockRes(): {
  status: (code: number) => { json: (data: unknown) => void };
  json: (data: unknown) => void;
  _status: number;
  _data: unknown;
} {
  const res = {
    _status: 200,
    _data: null as unknown,
    status(code: number) {
      res._status = code;
      return {
        json: (data: unknown) => {
          res._data = data;
        },
      };
    },
    json(data: unknown) {
      res._data = data;
    },
  };
  return res;
}

describe('Validation Handler', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
    initValidationTables(db);
  });

  describe('handleValidationSummary', () => {
    it('returns null for nonexistent agent', async () => {
      const req = mockReq({ id: 'nonexistent' });
      const res = mockRes();
      handleValidationSummary(db, req as never, res as never);
      expect(res._data).toEqual({ summary: null });
    });

    it('returns latest session for existing agent', async () => {
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

      const req = mockReq({ id: 'wiki-agent' });
      const res = mockRes();
      handleValidationSummary(db, req as never, res as never);
      const data = res._data as { summary: { validation_outcome: string } };
      expect(data.summary.validation_outcome).toBe('healthy');
    });
  });

  describe('handleValidationHistory', () => {
    it('returns empty array when no sessions', () => {
      const req = mockReq({ id: 'wiki-agent' });
      const res = mockRes();
      handleValidationHistory(db, req as never, res as never);
      expect(res._data).toEqual({ history: [] });
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

      const req = mockReq({ id: 'wiki-agent' });
      const res = mockRes();
      handleValidationHistory(db, req as never, res as never);
      const data = res._data as { history: Array<{ id: string }> };
      expect(data.history).toHaveLength(2);
      expect(data.history[0].id).toBe('vh-2');
    });
  });

  describe('handleValidationSessionDetail', () => {
    it('returns 404 for nonexistent session', () => {
      const req = mockReq({ id: 'nonexistent' });
      const res = mockRes();
      handleValidationSessionDetail(db, req as never, res as never);
      expect(res._status).toBe(404);
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

      const req = mockReq({ id: 'vd-1' });
      const res = mockRes();
      handleValidationSessionDetail(db, req as never, res as never);
      const data = res._data as { session: { id: string }; metrics: Array<{ name: string }> };
      expect(data.session.id).toBe('vd-1');
      expect(data.metrics).toHaveLength(1);
    });
  });

  describe('handleValidationCompare', () => {
    it('compares current session against approved baseline', () => {
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

      const req = mockReq({ id: 'wiki-agent' }, { session: 'vc-current', baseline: 'approved' });
      const res = mockRes();
      handleValidationCompare(db, req as never, res as never);
      const data = res._data as {
        current: { id: string };
        baseline: { id: string };
        deltas: Array<{ name: string; delta: number }>;
      };
      expect(data.current.session.id).toBe('vc-current');
      expect(data.baseline.session.id).toBe('vc-base');
      expect(data.deltas[0].delta).toBe(-1000); // improved
    });
  });

  describe('handleValidationApprove', () => {
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

      const req = mockReq({ id: 'wiki-agent' }, { session_id: 'va-1' });
      const res = mockRes();
      handleValidationApprove(db, req as never, res as never);
      const data = res._data as { success: boolean };
      expect(data.success).toBe(true);
    });
  });
});
