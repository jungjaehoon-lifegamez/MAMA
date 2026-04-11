import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import {
  initAgentTables,
  logActivity,
  getActivity,
  updateActivityScore,
} from '../../src/db/agent-store.js';

describe('agent_activity', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('creates agent_activity table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_activity'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('initAgentTables is idempotent with agent_activity', () => {
    initAgentTables(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_versions','agent_metrics','agent_activity')"
      )
      .all();
    expect(tables).toHaveLength(3);
  });

  describe('activity CRUD', () => {
    it('logs activity with details JSON', () => {
      const row = logActivity(db, {
        agent_id: 'test-agent',
        agent_version: 1,
        type: 'task_complete',
        input_summary: 'Process file X',
        output_summary: 'Matched to project A',
        tokens_used: 150,
        tools_called: ['Read', 'Bash'],
        duration_ms: 2300,
        details: { items: [{ input: 'file.mov', result: 'pass' }] },
      });
      expect(row.id).toBeGreaterThan(0);
      expect(row.type).toBe('task_complete');
      expect(JSON.parse(row.details!).items).toHaveLength(1);
      expect(JSON.parse(row.tools_called!)).toEqual(['Read', 'Bash']);
    });

    it('retrieves activity by agent_id newest first', () => {
      logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete' });
      logActivity(db, {
        agent_id: 'a1',
        agent_version: 1,
        type: 'task_error',
        error_message: 'timeout',
      });
      logActivity(db, { agent_id: 'a2', agent_version: 1, type: 'task_complete' });

      const a1 = getActivity(db, 'a1', 10);
      expect(a1).toHaveLength(2);
      expect(a1[0].type).toBe('task_error');
    });

    it('logs test_run with score and details', () => {
      const row = logActivity(db, {
        agent_id: 'test-agent',
        agent_version: 2,
        type: 'test_run',
        input_summary: '3 files tested',
        output_summary: '3/3 passed',
        score: 95,
        details: { total: 3, passed: 3, failed: 0, suggestion: null },
      });
      expect(row.score).toBe(95);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        logActivity(db, { agent_id: 'dev', agent_version: 1, type: 'task_complete' });
      }
      const rows = getActivity(db, 'dev', 3);
      expect(rows).toHaveLength(3);
    });

    it('defaults tokens_used and duration_ms to 0', () => {
      const row = logActivity(db, {
        agent_id: 'dev',
        agent_version: 1,
        type: 'task_start',
      });
      expect(row.tokens_used).toBe(0);
      expect(row.duration_ms).toBe(0);
    });

    it('updates activity score and details', () => {
      const row = logActivity(db, {
        agent_id: 'test-agent',
        agent_version: 1,
        type: 'test_run',
        input_summary: '3 items tested',
      });
      const updated = updateActivityScore(db, row.id, 85, {
        total: 3,
        passed: 2,
        failed: 1,
        items: [
          { input: 'a', result: 'pass' },
          { input: 'b', result: 'pass' },
          { input: 'c', result: 'fail' },
        ],
      });
      expect(updated.score).toBe(85);
      expect(JSON.parse(updated.details!).passed).toBe(2);
      expect(JSON.parse(updated.details!).items).toHaveLength(3);
    });
  });
});
