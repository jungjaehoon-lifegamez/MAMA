import { describe, expect, it, vi } from 'vitest';

import { handleSave, handleSearch } from '../../src/agent/mama-tool-handlers.js';
import type { MAMAApiInterface, TrustedMemoryWriteOptions } from '../../src/agent/types.js';

function createLegacyApi(): MAMAApiInterface {
  return {
    save: vi.fn().mockResolvedValue({
      success: true,
      id: 'legacy_save',
      type: 'decision',
    }),
    saveCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      id: 'checkpoint_1',
      type: 'checkpoint',
    }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true, message: 'updated' }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('Story M2.1: MAMA save handler compatibility', () => {
  describe('AC: legacy injected APIs remain writable', () => {
    it('uses public save when no trusted provenance options are supplied', async () => {
      const api = createLegacyApi();

      const result = await handleSave(api, {
        type: 'decision',
        topic: 'legacy_save_fallback',
        decision: 'Legacy API should still save',
        reasoning: 'Plain saves remain compatible with injected APIs',
      });

      expect(result).toMatchObject({ success: true, id: 'legacy_save' });
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'legacy_save_fallback',
          decision: 'Legacy API should still save',
          reasoning: 'Plain saves remain compatible with injected APIs',
        })
      );
    });

    it('fails closed when trusted provenance options cannot be honored', async () => {
      const api = createLegacyApi();
      const options: TrustedMemoryWriteOptions = {
        capability: Object.freeze({}),
        provenance: {
          actor: 'main_agent',
          gateway_call_id: 'gw_test',
        },
      };

      const result = await handleSave(
        api,
        {
          type: 'decision',
          topic: 'legacy_save_fallback',
          decision: 'Legacy API should still save',
          reasoning: 'Trusted provenance support is optional on injected APIs',
        },
        undefined,
        options
      );

      expect(result).toMatchObject({
        success: false,
        message: 'Trusted provenance save is unavailable.',
      });
      expect(api.save).not.toHaveBeenCalled();
    });
  });
});

describe('Story M2.2: operational run summary filtering', () => {
  describe('AC: only narrow operational summary topics are auto-skipped', () => {
    it('skips exact operational summary tokens and a numeric instance suffix', async () => {
      const api = createLegacyApi();

      const result = await handleSave(api, {
        type: 'decision',
        topic: 'system-audit-42',
        decision: 'Audit complete. 2 MINOR fixes applied.',
        reasoning: 'Full audit run summary.',
      });

      expect(result).toMatchObject({
        success: true,
        skipped: true,
        code: 'operational_memory_skipped',
      });
      expect(api.save).not.toHaveBeenCalled();
    });

    it('saves broad audit-looking topics unless an autosave marker is present', async () => {
      const api = createLegacyApi();

      const result = await handleSave(api, {
        type: 'decision',
        topic: 'audit-summary-2026-05-02',
        decision: 'Audit completed records should be retained for 30 days.',
        reasoning: 'This is a durable retention policy, not an operational autosave.',
      });

      expect(result).toMatchObject({ success: true, id: 'legacy_save' });
      expect(api.save).toHaveBeenCalledOnce();
    });
  });
});

describe('MAMA search handler option threading', () => {
  it('passes strictness and diagnostics to mama.suggest', async () => {
    const api = createLegacyApi();

    await handleSearch(api, {
      query: 'context compile',
      limit: 4,
      strictness: 'balanced',
      diagnostics: true,
    });

    expect(api.suggest).toHaveBeenCalledWith(
      'context compile',
      expect.objectContaining({
        limit: 4,
        strictness: 'balanced',
        diagnostics: true,
      })
    );
  });

  it('preserves diagnostics from mama.suggest responses', async () => {
    const api = createLegacyApi();
    vi.mocked(api.suggest).mockResolvedValueOnce({
      success: true,
      count: 1,
      diagnostics: {
        candidate_counts: {
          vector: 1,
          lexical: 1,
          entity: 0,
          graph_expanded: 0,
          vector_only: 0,
          rejected_by_strictness: 0,
        },
        threshold: 0.45,
        strictness: 'balanced',
      },
      results: [
        {
          id: 'decision_diagnostic',
          topic: 'diagnostic topic',
          decision: 'Diagnostic decision',
          created_at: '2026-04-30T00:00:00.000Z',
          type: 'decision',
          retrieval_diagnostics: {
            retrieval_source: 'hybrid_rrf',
            vector_similarity: 0.9,
            lexical_support: true,
            entity_support: false,
            scope_support: true,
            graph_source: 'primary',
            is_vector_only: false,
            confirmation_signals: ['lexical'],
            metadata_signals: ['scope', 'graph_primary'],
            candidate_threshold_used: 0.45,
          },
        },
      ],
    });

    const result = await handleSearch(api, {
      query: 'diagnostic topic',
      diagnostics: true,
    });

    expect(result.diagnostics).toMatchObject({
      threshold: 0.45,
      strictness: 'balanced',
    });
    expect(result.results[0].retrieval_diagnostics).toMatchObject({
      lexical_support: true,
      is_vector_only: false,
    });
  });

  it('propagates mama.suggest failures instead of returning an empty successful search', async () => {
    const api = createLegacyApi();
    vi.mocked(api.suggest).mockResolvedValueOnce({
      success: false,
      results: [],
      count: 0,
      code: 'suggest_failed',
      error: 'Vector index is unavailable',
    });

    const result = await handleSearch(api, {
      query: 'diagnostic topic',
    });

    expect(result).toMatchObject({
      success: false,
      results: [],
      count: 0,
      code: 'suggest_failed',
      error: 'Vector index is unavailable',
    });
  });

  it('passes scopes to listDecisions for recent scoped search', async () => {
    const api = createLegacyApi();
    const scopes = [{ kind: 'project' as const, id: 'alpha' }];

    await handleSearch(api, {
      limit: 3,
      scopes,
    });

    expect(api.listDecisions).toHaveBeenCalledWith({ limit: 3, scopes });
  });

  it('denies scoped checkpoint search until checkpoints have scoped reads', async () => {
    const api = createLegacyApi();

    const result = await handleSearch(api, {
      type: 'checkpoint',
      scopes: [{ kind: 'project', id: 'alpha' }],
    });

    expect(result).toMatchObject({
      success: false,
      count: 0,
      results: [],
      code: 'scoped_checkpoint_unsupported',
    });
    expect(api.loadCheckpoint).not.toHaveBeenCalled();
  });
});
