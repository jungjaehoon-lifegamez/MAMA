import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../public/viewer/src/utils/api.js', () => ({
  API: { get, post },
}));

describe('viewer entity-review module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('EntityReviewController.fetchCandidates', () => {
    it('calls the candidates endpoint and returns the parsed response', async () => {
      get.mockResolvedValue({
        candidates: [
          {
            id: 'cand_1',
            candidate_kind: 'cluster',
            status: 'pending',
            score_total: 0.92,
            left_ref: { kind: 'observation', id: 'o1', label: 'Project Alpha' },
            right_ref: { kind: 'observation', id: 'o2', label: 'Alpha Project' },
            created_at: '2026-04-12T00:00:00.000Z',
            scope_kind: 'channel',
            scope_id: 'C123',
          },
        ],
        next_cursor: 'cursor_x',
      });

      const { EntityReviewController } =
        await import('../../public/viewer/src/modules/entity-review.js');
      const controller = new EntityReviewController();
      const result = await controller.fetchCandidates({ limit: 10 });

      expect(get).toHaveBeenCalledWith('/api/entities/candidates', { limit: 10 });
      expect(result.candidates).toHaveLength(1);
      expect(result.next_cursor).toBe('cursor_x');
    });
  });

  describe('buildListRenderState', () => {
    it('renders row summaries and cursor', async () => {
      const { buildListRenderState } =
        await import('../../public/viewer/src/modules/entity-review.js');
      const state = buildListRenderState({
        candidates: [
          {
            id: 'cand_1',
            candidate_kind: 'cluster',
            status: 'pending',
            score_total: 0.91,
            left_ref: { kind: 'observation', id: 'o1', label: 'Project Alpha' },
            right_ref: { kind: 'observation', id: 'o2', label: 'Alpha Launch' },
            created_at: '2026-04-12T00:00:00.000Z',
            scope_kind: 'channel',
            scope_id: 'C123',
          },
        ],
        next_cursor: null,
      });

      expect(state.isEmpty).toBe(false);
      expect(state.total).toBe(1);
      expect(state.rows[0]?.scoreText).toBe('0.91');
      expect(state.rows[0]?.leftLabel).toBe('Project Alpha');
      expect(state.rows[0]?.rightLabel).toBe('Alpha Launch');
      expect(state.rows[0]?.scopeLabel).toBe('channel:C123');
      expect(state.nextCursor).toBeNull();
    });

    it('reports empty state for zero candidates', async () => {
      const { buildListRenderState, renderEmptyState } =
        await import('../../public/viewer/src/modules/entity-review.js');
      const state = buildListRenderState({ candidates: [], next_cursor: null });
      expect(state.isEmpty).toBe(true);
      expect(renderEmptyState()).toContain('No candidates');
    });
  });

  describe('buildDetailRenderState', () => {
    it('returns a full score breakdown, rule trace, and evidence passthrough', async () => {
      const { buildDetailRenderState } =
        await import('../../public/viewer/src/modules/entity-review.js');
      const state = buildDetailRenderState({
        candidate: {
          id: 'cand_1',
          candidate_kind: 'cluster',
          status: 'pending',
          score_total: 0.91,
          score_structural: 1,
          score_string: 0.5,
          score_context: 0.25,
          score_graph: 0,
          score_embedding: 0,
          left_ref: { kind: 'observation', id: 'o1', label: 'Project Alpha' },
          right_ref: { kind: 'observation', id: 'o2', label: 'Alpha Launch' },
          created_at: '2026-04-12T00:00:00.000Z',
          scope_kind: 'channel',
          scope_id: 'C123',
          rule_trace: ['normalized_form_match', 'scope_match'],
          evidence: [
            {
              id: 'o1',
              surface_form: 'Project Alpha',
              normalized_form: 'project alpha',
              lang: 'en',
              script: 'Latn',
              context_summary: 'kickoff',
              scope_kind: 'channel',
              scope_id: 'C123',
              source_connector: 'slack',
              source_raw_record_id: 'raw_o1',
              timestamp_observed: 1710000000000,
            },
          ],
          extractor_version: 'history-extractor@v1',
          embedding_model_version: 'multilingual-e5-large',
        },
      });

      expect(state.scoreBreakdown).toHaveLength(6);
      expect(state.scoreBreakdown[0]?.key).toBe('total');
      expect(state.ruleTrace).toEqual(['normalized_form_match', 'scope_match']);
      expect(state.evidence).toHaveLength(1);
      expect(state.extractorVersion).toBe('history-extractor@v1');
    });
  });

  describe('EntityReviewController.review', () => {
    it.each([['approve'], ['reject'], ['defer']] as const)(
      '%s triggers POST to the action endpoint',
      async (action) => {
        post.mockResolvedValue({
          candidate_id: 'cand_1',
          merge_action_id: 'mact_1',
          action,
          actor_id: 'local:127.0.0.1',
          created_at: '2026-04-12T00:00:00.000Z',
        });

        const { EntityReviewController } =
          await import('../../public/viewer/src/modules/entity-review.js');
        const controller = new EntityReviewController();
        const result = await controller.review('cand_1', action, { reason: 'looks right' });

        expect(post).toHaveBeenCalledWith(`/api/entities/candidates/cand_1/${action}`, {
          reason: 'looks right',
        });
        expect(result.merge_action_id).toBe('mact_1');
      }
    );
  });
});
