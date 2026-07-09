/**
 * LLM eval for M2 (real claude CLI): given a synthetic window + one fire recall, the agent
 * composes a non-empty situation report. Gated behind RUN_LLM_EVAL=1 so normal CI stays offline.
 * Synthetic data only - no personal strings.
 * Run: RUN_LLM_EVAL=1 npx vitest run tests/operator/situation-report.eval.test.ts
 */
import { describe, it, expect } from 'vitest';
import { SituationReporter } from '../../src/operator/situation-report.js';
import { askAgentCLI } from '../../src/operator/trigger-author.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

const RUN = process.env.RUN_LLM_EVAL === '1';
function ev(id: number, channelId: string, content: string): OperatorChannelEvent {
  return { id, channel: 'slack', channelId, userId: 'u1', role: 'user', content, createdAt: id * 100 };
}

describe.skipIf(!RUN)('SituationReporter LLM eval (real claude CLI)', () => {
  it(
    'composes a non-empty situation report from a synthetic window + fire recall',
    async () => {
      const r = new SituationReporter();
      r.recordWindow([
        ev(1, 'slack:eng', 'the nightly deploy failed again, third time this week'),
        ev(2, 'slack:eng', 'rolling back to the previous build'),
        ev(3, 'slack:eng', 'who owns the deploy pipeline now?'),
        ev(4, 'slack:random', 'coffee run in 5'),
      ]);
      r.recordFire({
        triggerId: 't.deploy',
        kind: 'deploy_failure',
        channelId: 'slack:eng',
        recalled: [{ topic: 'deploy-owner', content: 'CI pipeline owned by the platform team since March' }],
      });
      const sent: string[] = [];
      const ok = await r.report(askAgentCLI, { send: async (t) => { sent.push(t); } }, 'full');
      // eslint-disable-next-line no-console
      console.log('EVAL situation report:', sent[0]);
      expect(ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].toLowerCase()).toContain('deploy');
    },
    120000
  );
});
