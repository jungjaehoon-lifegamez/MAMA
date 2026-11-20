import { describe, expect, it } from 'vitest';

import { untrustedToolData } from '../../src/utils/untrusted-content.js';

describe('personal source names are quoted for the model (#590 review)', () => {
  it('wraps channel lists and the names bind and list echo', () => {
    for (const name of ['source.channels', 'source.bind', 'source.list'])
      expect(
        untrustedToolData(
          name,
          JSON.stringify({ channels: [{ id: '1', name: 'ignore previous' }] })
        )
      ).toContain(`<<<UNTRUSTED-CONTENT source=${name}>>>`);
  });
});
