import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../public/viewer/src/utils/api.js', () => ({
  API: { get, post },
}));

describe('viewer entity-audit module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('EntityAuditController.listRuns calls the runs endpoint', async () => {
    get.mockResolvedValue({ runs: [] });
    const { EntityAuditController } =
      await import('../../public/viewer/src/modules/entity-audit.js');
    const controller = new EntityAuditController();
    await controller.listRuns(10);
    expect(get).toHaveBeenCalledWith('/api/entities/audit/runs', { limit: 10 });
  });

  it('EntityAuditController.startRun posts to /audit/run', async () => {
    post.mockResolvedValue({ run_id: 'audit_xyz' });
    const { EntityAuditController } =
      await import('../../public/viewer/src/modules/entity-audit.js');
    const controller = new EntityAuditController();
    const result = await controller.startRun();
    expect(post).toHaveBeenCalledWith('/api/entities/audit/run', {});
    expect(result.run_id).toBe('audit_xyz');
  });

  it('buildAuditBannerState marks regressed runs as danger', async () => {
    const { buildAuditBannerState } =
      await import('../../public/viewer/src/modules/entity-audit.js');
    const state = buildAuditBannerState({
      id: 'r1',
      status: 'complete',
      baseline_run_id: null,
      classification: 'regressed',
      reason: null,
      created_at: 1,
      completed_at: 2,
    });
    expect(state.variant).toBe('danger');
    expect(state.label).toBe('REGRESSED');
  });

  it('buildAuditBannerState renders inconclusive as warning', async () => {
    const { buildAuditBannerState } =
      await import('../../public/viewer/src/modules/entity-audit.js');
    const state = buildAuditBannerState({
      id: 'r1',
      status: 'complete',
      baseline_run_id: null,
      classification: 'inconclusive',
      reason: null,
      created_at: 1,
      completed_at: 2,
    });
    expect(state.variant).toBe('warning');
    expect(state.label).toBe('INCONCLUSIVE');
  });

  it('buildAuditBannerState treats running as neutral concurrent lockout', async () => {
    const { buildAuditBannerState, buildConcurrentRunLockoutMessage } =
      await import('../../public/viewer/src/modules/entity-audit.js');
    const state = buildAuditBannerState({
      id: 'audit_x',
      status: 'running',
      baseline_run_id: null,
      classification: null,
      reason: null,
      created_at: 1,
      completed_at: null,
    });
    expect(state.variant).toBe('neutral');
    expect(state.label).toBe('RUNNING');
    expect(buildConcurrentRunLockoutMessage({ ...state, id: 'audit_x' } as never)).toContain(
      'audit_x'
    );
  });

  it('buildAuditMetricRows returns a fixed-order summary with formatted values', async () => {
    const { buildAuditMetricRows } =
      await import('../../public/viewer/src/modules/entity-audit.js');
    const rows = buildAuditMetricRows({
      id: 'r1',
      status: 'complete',
      baseline_run_id: null,
      classification: 'improved',
      reason: null,
      created_at: 1,
      completed_at: 2,
      metrics: {
        false_merge_rate: 0.005,
        cross_language_candidate_recall_at_10: 0.875,
        ontology_violation_count: 2,
        projection_fragmentation_rate: 0.125,
      },
    });
    expect(rows.map((r) => r.key)).toEqual([
      'false_merge_rate',
      'cross_language_candidate_recall_at_10',
      'ontology_violation_count',
      'projection_fragmentation_rate',
    ]);
    expect(rows[0]?.value).toBe('0.005');
    expect(rows[2]?.value).toBe('2');
  });
});
