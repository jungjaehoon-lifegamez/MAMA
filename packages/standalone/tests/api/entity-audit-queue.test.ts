import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { AuditRunInProgressError, EntityAuditRunQueue } from '../../src/api/entity-audit-queue.js';

describe('EntityAuditRunQueue', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-audit-queue');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM entity_audit_findings').run();
    adapter.prepare('DELETE FROM entity_audit_metrics').run();
    adapter.prepare('DELETE FROM entity_audit_runs').run();
  });

  it('enqueues a running run and returns a run_id', () => {
    const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
    const result = queue.enqueue({ reason: 'manual' });
    expect(result.run_id).toMatch(/^audit_/);

    const status = queue.getStatus(result.run_id);
    expect(status?.status).toBe('running');
    expect(status?.reason).toBe('manual');
  });

  it('raises AuditRunInProgressError when a second run overlaps', () => {
    const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
    queue.enqueue();
    expect(() => queue.enqueue()).toThrow(AuditRunInProgressError);
  });

  it('transitions runs through complete and persists classification', () => {
    const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
    const { run_id } = queue.enqueue();
    queue.complete(run_id, {
      classification: 'stable',
      metric_summary: { false_merge_rate: 0 },
    });
    const status = queue.getStatus(run_id);
    expect(status?.status).toBe('complete');
    expect(status?.classification).toBe('stable');
    expect(status?.metric_summary_json).toContain('false_merge_rate');
  });

  it('fail() marks a run as failed and releases the partial lock', () => {
    const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
    const { run_id } = queue.enqueue();
    queue.fail(run_id, 'benchmark_crash');
    const status = queue.getStatus(run_id);
    expect(status?.status).toBe('failed');
    expect(status?.reason).toBe('benchmark_crash');

    // A new run can now start because no row has status='running'.
    const second = queue.enqueue();
    expect(queue.getStatus(second.run_id)?.status).toBe('running');
  });

  it('markTimeout moves a run to timeout and releases the lock', () => {
    const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
    const { run_id } = queue.enqueue();
    queue.markTimeout(run_id);
    expect(queue.getStatus(run_id)?.status).toBe('timeout');
  });

  it('recoverOrphans marks any running rows as failed on boot', () => {
    const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
    queue.enqueue();
    const recovered = queue.recoverOrphans();
    expect(recovered).toBeGreaterThanOrEqual(1);
    const rows = queue.list();
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.reason).toBe('standalone_restart');
  });
});
