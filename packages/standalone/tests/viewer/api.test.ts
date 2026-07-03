import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API } from '../../public/viewer/src/utils/api.js';

describe('viewer API utility', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

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
