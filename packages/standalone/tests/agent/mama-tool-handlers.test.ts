import { describe, expect, it, vi } from 'vitest';

import { handleSave } from '../../src/agent/mama-tool-handlers.js';
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
    it('falls back to public save when trusted provenance save is unavailable', async () => {
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

      expect(result).toMatchObject({ success: true, id: 'legacy_save' });
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'legacy_save_fallback',
          decision: 'Legacy API should still save',
          reasoning: 'Trusted provenance support is optional on injected APIs',
        })
      );
    });
  });
});
