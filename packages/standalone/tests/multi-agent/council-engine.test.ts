/**
 * Tests for CouncilEngine
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CouncilEngine } from '../../src/multi-agent/council-engine.js';
import type {
  CouncilPlan,
  CouncilConfig,
  CouncilProgressEvent,
} from '../../src/multi-agent/workflow-types.js';

process.env.MAMA_FORCE_TIER_3 = 'true';

const defaultConfig: CouncilConfig = {
  enabled: true,
  max_rounds: 5,
  max_duration_ms: 60000,
};

function makePlan(overrides: Partial<CouncilPlan> = {}): CouncilPlan {
  return {
    name: 'Test Council',
    topic: 'Should we use PostgreSQL or MongoDB?',
    agents: ['artisan', 'critic'],
    rounds: 2,
    ...overrides,
  };
}

const agentDisplayNames = new Map([
  ['artisan', '🎨 Artisan'],
  ['critic', '🔍 Critic'],
  ['conductor', '🎯 Conductor'],
]);

describe('CouncilEngine', () => {
  let engine: CouncilEngine;

  beforeEach(() => {
    engine = new CouncilEngine(defaultConfig);
  });

  describe('isEnabled', () => {
    it('returns true when enabled', () => {
      expect(engine.isEnabled()).toBe(true);
    });

    it('returns false when disabled', () => {
      const disabled = new CouncilEngine({ enabled: false });
      expect(disabled.isEnabled()).toBe(false);
    });
  });

  describe('parseCouncilPlan', () => {
    it('parses valid council_plan block', () => {
      const response = `Let me organize a discussion.

\`\`\`council_plan
{
  "name": "DB Discussion",
  "topic": "PostgreSQL vs MongoDB",
  "agents": ["artisan", "critic"],
  "rounds": 2
}
\`\`\`

I'll moderate this discussion.`;

      const plan = engine.parseCouncilPlan(response);
      expect(plan).not.toBeNull();
      expect(plan!.name).toBe('DB Discussion');
      expect(plan!.topic).toBe('PostgreSQL vs MongoDB');
      expect(plan!.agents).toEqual(['artisan', 'critic']);
      expect(plan!.rounds).toBe(2);
    });

    it('returns null for missing block', () => {
      expect(engine.parseCouncilPlan('No plan here')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const response = '```council_plan\n{invalid json}\n```';
      expect(engine.parseCouncilPlan(response)).toBeNull();
    });

    it('returns null for missing required fields', () => {
      const response = '```council_plan\n{"name":"Test"}\n```';
      expect(engine.parseCouncilPlan(response)).toBeNull();
    });

    it('returns null for empty agents array', () => {
      const response = '```council_plan\n{"name":"Test","topic":"T","agents":[],"rounds":1}\n```';
      expect(engine.parseCouncilPlan(response)).toBeNull();
    });

    it('returns null for rounds < 1', () => {
      const response =
        '```council_plan\n{"name":"Test","topic":"T","agents":["a","b"],"rounds":0}\n```';
      expect(engine.parseCouncilPlan(response)).toBeNull();
    });

    it('parses optional fields', () => {
      const response = `\`\`\`council_plan
{
  "name": "Test",
  "topic": "T",
  "agents": ["artisan", "critic"],
  "rounds": 1,
  "synthesis": false,
  "timeout_ms": 30000
}
\`\`\``;
      const plan = engine.parseCouncilPlan(response);
      expect(plan).not.toBeNull();
      expect(plan!.synthesis).toBe(false);
      expect(plan!.timeout_ms).toBe(30000);
    });
  });

  describe('extractNonPlanContent', () => {
    it('extracts text outside council_plan block', () => {
      const response = `Before text.

\`\`\`council_plan
{"name":"T","topic":"T","agents":["a"],"rounds":1}
\`\`\`

After text.`;

      const content = engine.extractNonPlanContent(response);
      expect(content).toBe('Before text.\n\n\n\nAfter text.');
    });

    it('returns full text when no block present', () => {
      expect(engine.extractNonPlanContent('Hello world')).toBe('Hello world');
    });
  });

  describe('validatePlan', () => {
    const availableAgents = ['artisan', 'critic', 'conductor'];

    it('returns null for valid plan', () => {
      expect(engine.validatePlan(makePlan(), availableAgents)).toBeNull();
    });

    it('rejects too many rounds', () => {
      const err = engine.validatePlan(makePlan({ rounds: 10 }), availableAgents);
      expect(err).toContain('Too many rounds');
    });

    it('rejects rounds < 1', () => {
      // Force a plan with rounds=0 (bypassing parse validation)
      const err = engine.validatePlan({ ...makePlan(), rounds: 0 }, availableAgents);
      expect(err).toContain('at least 1');
    });

    it('rejects unknown agents', () => {
      const err = engine.validatePlan(
        makePlan({ agents: ['artisan', 'unknown_bot'] }),
        availableAgents
      );
      expect(err).toContain('Unknown agent(s): unknown_bot');
    });

    it('rejects fewer than 2 agents', () => {
      const err = engine.validatePlan(makePlan({ agents: ['artisan'] }), availableAgents);
      expect(err).toContain('at least 2 agents');
    });
  });

  describe('buildRoundPrompt', () => {
    it('builds first round prompt with no previous results', () => {
      const prompt = engine.buildRoundPrompt('DB choice', [], 1, 'artisan', '🎨 Artisan');
      expect(prompt).toContain('Council Discussion: DB choice');
      expect(prompt).toContain('🎨 Artisan');
      expect(prompt).toContain('Round 1');
      expect(prompt).toContain('Share your perspective');
      expect(prompt).not.toContain('Previous Responses');
    });

    it('includes previous responses in subsequent rounds', () => {
      const prev = [
        {
          round: 1,
          agentId: 'artisan',
          agentDisplayName: '🎨 Artisan',
          response: 'I prefer PostgreSQL for ACID compliance.',
          duration_ms: 1000,
          status: 'success' as const,
        },
      ];

      const prompt = engine.buildRoundPrompt('DB choice', prev, 2, 'critic', '🔍 Critic');
      expect(prompt).toContain('Previous Responses');
      expect(prompt).toContain('🎨 Artisan');
      expect(prompt).toContain('I prefer PostgreSQL');
      expect(prompt).toContain('Consider what others have said');
    });

    it('marks own previous responses with (you)', () => {
      const prev = [
        {
          round: 1,
          agentId: 'artisan',
          agentDisplayName: '🎨 Artisan',
          response: 'My first take.',
          duration_ms: 1000,
          status: 'success' as const,
        },
      ];

      const prompt = engine.buildRoundPrompt('DB choice', prev, 2, 'artisan', '🎨 Artisan');
      expect(prompt).toContain('(you)');
    });

    it('excludes failed responses from context', () => {
      const prev = [
        {
          round: 1,
          agentId: 'artisan',
          agentDisplayName: '🎨 Artisan',
          response: '',
          duration_ms: 1000,
          status: 'failed' as const,
          error: 'timeout',
        },
      ];

      const prompt = engine.buildRoundPrompt('DB choice', prev, 1, 'critic', '🔍 Critic');
      expect(prompt).not.toContain('🎨 Artisan');
    });
  });

  describe('execute', () => {
    it('executes 2 rounds × 2 agents = 4 results', async () => {
      const executor = vi.fn().mockResolvedValue('Agent response');

      const { result, execution } = await engine.execute(makePlan(), executor, agentDisplayNames);

      expect(execution.status).toBe('completed');
      expect(execution.rounds).toHaveLength(4);
      expect(executor).toHaveBeenCalledTimes(4);

      // Verify round ordering
      expect(execution.rounds[0].round).toBe(1);
      expect(execution.rounds[0].agentId).toBe('artisan');
      expect(execution.rounds[1].round).toBe(1);
      expect(execution.rounds[1].agentId).toBe('critic');
      expect(execution.rounds[2].round).toBe(2);
      expect(execution.rounds[2].agentId).toBe('artisan');
      expect(execution.rounds[3].round).toBe(2);
      expect(execution.rounds[3].agentId).toBe('critic');

      expect(result).toContain('Council: Test Council');
      expect(result).toContain('Round 1');
      expect(result).toContain('Round 2');
    });

    it('continues when an agent fails', async () => {
      let callCount = 0;
      const executor = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('Agent crashed');
        return 'OK response';
      });

      const { execution } = await engine.execute(makePlan(), executor, agentDisplayNames);

      expect(execution.status).toBe('completed');
      expect(execution.rounds).toHaveLength(4);
      expect(execution.rounds[1].status).toBe('failed');
      expect(execution.rounds[1].error).toBe('Agent crashed');
      // Other rounds still succeeded
      expect(execution.rounds[0].status).toBe('success');
      expect(execution.rounds[2].status).toBe('success');
      expect(execution.rounds[3].status).toBe('success');
    });

    it('marks timeout errors correctly', async () => {
      const executor = vi.fn().mockImplementation(async (_id: string, _p: string, _t: number) => {
        throw new Error('Council agent timeout (120000ms)');
      });

      const { execution } = await engine.execute(
        makePlan({ rounds: 1 }),
        executor,
        agentDisplayNames
      );

      expect(execution.rounds[0].status).toBe('timeout');
      expect(execution.rounds[1].status).toBe('timeout');
    });

    it('emits progress events for each round', async () => {
      const executor = vi.fn().mockResolvedValue('Response');
      const events: CouncilProgressEvent[] = [];
      engine.on('progress', (e: CouncilProgressEvent) => events.push(e));

      await engine.execute(makePlan({ rounds: 1 }), executor, agentDisplayNames);

      const types = events.map((e) => e.type);
      expect(types).toContain('council-round-started');
      expect(types).toContain('council-round-completed');
      expect(types).toContain('council-completed');

      // 2 agents × 1 round = 2 started + 2 completed + 1 council-completed = 5
      expect(events.filter((e) => e.type === 'council-round-started')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'council-round-completed')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'council-completed')).toHaveLength(1);
    });

    it('passes accumulated history to subsequent prompts', async () => {
      const prompts: string[] = [];
      const executor = vi.fn().mockImplementation(async (_id: string, prompt: string) => {
        prompts.push(prompt);
        return `Response from call ${prompts.length}`;
      });

      await engine.execute(makePlan({ rounds: 1 }), executor, agentDisplayNames);

      // First agent: no previous responses
      expect(prompts[0]).not.toContain('Previous Responses');
      // Second agent: should see first agent's response
      expect(prompts[1]).toContain('Previous Responses');
      expect(prompts[1]).toContain('Response from call 1');
    });

    it('handles cancellation via global timeout', async () => {
      const shortConfig: CouncilConfig = {
        enabled: true,
        max_duration_ms: 50,
      };
      const shortEngine = new CouncilEngine(shortConfig);

      const executor = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'late response';
      });

      const { execution } = await shortEngine.execute(
        makePlan({ rounds: 3 }),
        executor,
        agentDisplayNames
      );

      expect(execution.status).toBe('cancelled');
      expect(execution.rounds.length).toBeLessThan(6); // 3 rounds × 2 agents = 6 max
    });
  });

  describe('cancel', () => {
    it('cancels running execution', async () => {
      let executionId = '';
      const executor = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'response';
      });

      engine.on('progress', (e: CouncilProgressEvent) => {
        if (e.type === 'council-round-started' && !executionId) {
          executionId = e.executionId;
          engine.cancel(executionId);
        }
      });

      const { execution } = await engine.execute(
        makePlan({ rounds: 3 }),
        executor,
        agentDisplayNames
      );

      expect(execution.status).toBe('cancelled');
    });

    it('returns false for unknown execution', () => {
      expect(engine.cancel('nonexistent')).toBe(false);
    });
  });

  describe('buildFinalResult', () => {
    it('returns cancellation message for cancelled execution', async () => {
      const shortEngine = new CouncilEngine({ enabled: true, max_duration_ms: 1 });
      const executor = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'response';
      });

      const { result } = await shortEngine.execute(makePlan(), executor, agentDisplayNames);
      expect(result).toContain('cancelled');
    });

    it('includes all successful round results grouped by round', async () => {
      const executor = vi.fn().mockResolvedValue('My opinion here.');

      const { result } = await engine.execute(makePlan({ rounds: 2 }), executor, agentDisplayNames);

      expect(result).toContain('## Council: Test Council');
      expect(result).toContain('### Round 1');
      expect(result).toContain('### Round 2');
      expect(result).toContain('🎨 Artisan');
      expect(result).toContain('🔍 Critic');
    });
  });
});
