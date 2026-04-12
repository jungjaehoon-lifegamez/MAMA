import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import { initAgentTables, logActivity, getActivitySummary } from '../../src/db/agent-store.js';

describe('getActivitySummary', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  it('returns per-agent summary for period', () => {
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete', duration_ms: 1000 });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete', duration_ms: 2000 });
    logActivity(db, {
      agent_id: 'a1',
      agent_version: 1,
      type: 'task_error',
      error_message: 'fail',
    });
    logActivity(db, { agent_id: 'a2', agent_version: 1, type: 'task_complete' });

    const summary = getActivitySummary(db, '2000-01-01');
    expect(summary).toHaveLength(2);

    const a1 = summary.find((s) => s.agent_id === 'a1')!;
    expect(a1.total).toBe(3);
    expect(a1.errors).toBe(1);
    expect(a1.error_rate).toBeCloseTo(33.33, 0);
  });

  it('returns empty array when no activity', () => {
    expect(getActivitySummary(db, '2000-01-01')).toEqual([]);
  });

  it('detects consecutive errors', () => {
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e1' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e2' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e3' });

    const summary = getActivitySummary(db, '2000-01-01');
    const a1 = summary.find((s) => s.agent_id === 'a1')!;
    expect(a1.consecutive_errors).toBe(3);
  });

  it('breaks consecutive count on non-error', () => {
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e1' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e2' });

    const summary = getActivitySummary(db, '2000-01-01');
    const a1 = summary.find((s) => s.agent_id === 'a1')!;
    expect(a1.consecutive_errors).toBe(2);
  });

  it('counts only terminal outcomes in aggregate totals and rates', () => {
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_start' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete', duration_ms: 1000 });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'audit_failed', duration_ms: 2000 });

    const summary = getActivitySummary(db, '2000-01-01');
    const a1 = summary.find((s) => s.agent_id === 'a1')!;
    expect(a1.total).toBe(2);
    expect(a1.completed).toBe(1);
    expect(a1.errors).toBe(1);
    expect(a1.error_rate).toBe(50);
    expect(a1.avg_duration_ms).toBe(1500);
  });

  it('ignores non-terminal task_start rows when computing consecutive errors', () => {
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_start' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e1' });
    logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_error', error_message: 'e2' });

    const summary = getActivitySummary(db, '2000-01-01');
    const a1 = summary.find((s) => s.agent_id === 'a1')!;
    expect(a1.consecutive_errors).toBe(2);
  });
});
