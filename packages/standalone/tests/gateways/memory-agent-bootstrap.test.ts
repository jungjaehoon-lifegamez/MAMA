import { describe, expect, it } from 'vitest';

import { buildStandaloneMemoryBootstrap } from '../../src/memory/bootstrap-context.js';

describe('standalone memory bootstrap', () => {
  it('should include current goal, truth snapshot, and open findings', async () => {
    const packet = await buildStandaloneMemoryBootstrap({
      mamaApi: {
        buildMemoryBootstrap: async ({ scopes, currentGoal }) => ({
          current_goal: currentGoal,
          scope_context: scopes,
          truth_snapshot: [
            {
              id: 'truth_1',
              topic: 'memory_bootstrap',
              summary: 'Use pnpm in this repo',
              trust_score: 0.9,
            },
          ],
          open_audit_findings: [
            {
              id: 'finding_1',
              kind: 'memory_conflict',
              severity: 'high',
              summary: 'conflict found',
            },
          ],
          recent_memory_events: [],
        }),
      },
      scopes: [{ kind: 'project', id: '/repo' }],
      currentGoal: 'stabilize telegram memory behavior',
    });

    expect(packet.current_goal).toBe('stabilize telegram memory behavior');
    expect(Array.isArray(packet.truth_snapshot)).toBe(true);
    expect(Array.isArray(packet.open_audit_findings)).toBe(true);
    expect(packet.truth_snapshot[0]?.topic).toBe('memory_bootstrap');
    expect(packet.open_audit_findings[0]?.summary).toBe('conflict found');
  });
});
