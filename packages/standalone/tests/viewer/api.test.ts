import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API } from '../../public/viewer/src/utils/api.js';

describe('Story V19.15: Viewer API request options', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  describe('AC #1: POST request options are optional at runtime', () => {
    it('allows null request options for POST calls', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await API.post('/api/test', { ok: true }, null);

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      });
    });
  });
});
