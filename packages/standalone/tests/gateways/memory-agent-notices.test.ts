import { describe, expect, it } from 'vitest';

import { shouldDeliverAuditNotice } from '../../src/memory/agent-notice-queue.js';

describe('memory agent notices', () => {
  it('should deliver high-severity notices', () => {
    expect(
      shouldDeliverAuditNotice({
        type: 'truth_conflict',
        severity: 'high',
        summary: 'conflict',
        evidence: [],
        recommended_action: 'consult_memory',
        relevant_memories: [],
      })
    ).toBe(true);
  });

  it('should suppress low-severity noise', () => {
    expect(
      shouldDeliverAuditNotice({
        type: 'truth_update',
        severity: 'low',
        summary: 'minor update',
        evidence: [],
        recommended_action: 'use_truth_snapshot',
        relevant_memories: [],
      })
    ).toBe(false);
  });
});
