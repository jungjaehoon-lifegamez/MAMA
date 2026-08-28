import { describe, expect, it } from 'vitest';

import { workOrderActivityDetails } from '../../src/cli/commands/start.js';

describe('Story ONB-9: workorder activity records brief lineage', () => {
  it('stores the brief hash in the existing JSON details payload', () => {
    expect(
      workOrderActivityDetails({
        type: 'complete',
        workKind: 'board',
        workOrderId: 42,
        briefHash: '0123456789abcdef',
      })
    ).toEqual({ brief_hash: '0123456789abcdef' });
  });

  it('omits details when no worker run supplied a hash', () => {
    expect(
      workOrderActivityDetails({ type: 'failed', workKind: 'board', workOrderId: 42 })
    ).toBeUndefined();
  });
});
