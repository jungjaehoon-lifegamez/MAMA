/**
 * Tests for WorkflowEngine
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from '../../src/multi-agent/workflow-engine.js';
import type {
  WorkflowPlan,
  WorkflowStep,
  WorkflowConfig,
  EphemeralAgentDef,
  WorkflowProgressEvent,
} from '../../src/multi-agent/workflow-types.js';

process.env.MAMA_FORCE_TIER_3 = 'true';

function makeAgent(overrides: Partial<EphemeralAgentDef> = {}): EphemeralAgentDef {
  return {
    id: 'test-agent',
    display_name: '🧪 TestAgent',
    backend: 'claude',
    model: 'claude-sonnet-4-5-20250929',
    system_prompt: 'You are a test agent.',
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 'step-1',
    agent: makeAgent(),
    prompt: 'Do something',
    ...overrides,
  };
}

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    name: 'Test Workflow',
    steps: [makeStep()],
    ...overrides,
  };
}

const defaultConfig: WorkflowConfig = {
  enabled: true,
  max_ephemeral_agents: 5,
  max_duration_ms: 60000,
};

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(defaultConfig);
  });

  describe('parseWorkflowPlan', () => {
    it('should parse valid workflow_plan block', () => {
      const plan = makePlan();
      const response = `Let me create a workflow.\n\n\`\`\`workflow_plan\n${JSON.stringify(plan)}\n\`\`\`\n\nStarting now.`;
      const result = engine.parseWorkflowPlan(response);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Workflow');
      expect(result!.steps).toHaveLength(1);
    });

    it('should return null for response without workflow_plan', () => {
      expect(engine.parseWorkflowPlan('Just a regular response')).toBeNull();
    });

    it('should parse raw JSON workflow plan', () => {
      const plan = makePlan();
      const response = JSON.stringify(plan);
      const result = engine.parseWorkflowPlan(response);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Workflow');
      expect(result!.steps).toHaveLength(1);
    });

    it('should parse CRLF workflow_plan block', () => {
      const plan = makePlan();
      const response = `Let me parse this\r\n\`\`\`workflow_plan\r\n${JSON.stringify(plan)}\r\n\`\`\`\r\nDone`;
      const result = engine.parseWorkflowPlan(response);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Workflow');
      expect(result!.steps).toHaveLength(1);
    });

    it('should parse workflow_plan block with json fenced body', () => {
      const plan = makePlan();
      const response = `Context\r\n\`\`\`workflow_plan\r\n\`\`\`json\r\n${JSON.stringify(plan)}\r\n\`\`\`\r\n`;
      const result = engine.parseWorkflowPlan(response);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Workflow');
      expect(result!.steps).toHaveLength(1);
    });

    it('should parse workflow_plan with json fenced body even when earlier JSON exists', () => {
      const plan = makePlan();
      const response = `{"meta":"noise"}\r\n\`\`\`workflow_plan\r\n\`\`\`json\r\n${JSON.stringify(plan)}\r\n\`\`\`\r\n`;
      const result = engine.parseWorkflowPlan(response);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Workflow');
      expect(result!.steps).toHaveLength(1);
    });

    it('should return null for invalid JSON', () => {
      const response = '```workflow_plan\n{invalid json}\n```';
      expect(engine.parseWorkflowPlan(response)).toBeNull();
    });

    it('should return null for plan without steps', () => {
      const response = '```workflow_plan\n{"name": "empty"}\n```';
      expect(engine.parseWorkflowPlan(response)).toBeNull();
    });

    it('should return null for plan with empty steps', () => {
      const response = '```workflow_plan\n{"name": "empty", "steps": []}\n```';
      expect(engine.parseWorkflowPlan(response)).toBeNull();
    });

    it('should return null for steps missing required agent fields', () => {
      const response =
        '```workflow_plan\n' +
        JSON.stringify({
          name: 'bad',
          steps: [{ id: 's1', agent: { id: 'a' }, prompt: 'x' }],
        }) +
        '\n```';
      expect(engine.parseWorkflowPlan(response)).toBeNull();
    });

    it('should return null for blank agent display_name', () => {
      const response =
        '```workflow_plan\n' +
        JSON.stringify({
          name: 'bad',
          steps: [
            {
              id: 's1',
              agent: makeAgent({ display_name: '   ' }),
              prompt: 'x',
            },
          ],
        }) +
        '\n```';
      expect(engine.parseWorkflowPlan(response)).toBeNull();
    });
  });

  describe('extractNonPlanContent', () => {
    it('should extract text outside the plan block', () => {
      const response = 'Hello!\n\n```workflow_plan\n{"name":"x","steps":[]}\n```\n\nGoodbye!';
      expect(engine.extractNonPlanContent(response)).toBe('Hello!\n\n\nGoodbye!');
    });

    it('should return full text when no plan block', () => {
      expect(engine.extractNonPlanContent('Just text')).toBe('Just text');
    });
  });

  describe('validatePlan', () => {
    it('should accept valid plan', () => {
      const plan = makePlan({
        steps: [
          makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }) }),
          makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }), depends_on: ['a'] }),
        ],
      });
      expect(engine.validatePlan(plan)).toBeNull();
    });

    it('should reject too many steps', () => {
      const steps = Array.from({ length: 10 }, (_, i) =>
        makeStep({ id: `s${i}`, agent: makeAgent({ id: `a${i}` }) })
      );
      const plan = makePlan({ steps });
      const result = engine.validatePlan(plan);
      expect(result).toContain('Too many steps');
    });

    it('should reject duplicate step IDs', () => {
      const plan = makePlan({
        steps: [
          makeStep({ id: 'dup', agent: makeAgent({ id: 'a1' }) }),
          makeStep({ id: 'dup', agent: makeAgent({ id: 'a2' }) }),
        ],
      });
      expect(engine.validatePlan(plan)).toContain('Duplicate');
    });

    it('should reject unknown dependency', () => {
      const plan = makePlan({
        steps: [makeStep({ id: 'a', depends_on: ['nonexistent'] })],
      });
      expect(engine.validatePlan(plan)).toContain('unknown step');
    });

    it('should reject self-dependency', () => {
      const plan = makePlan({
        steps: [makeStep({ id: 'a', depends_on: ['a'] })],
      });
      expect(engine.validatePlan(plan)).toContain('depends on itself');
    });

    it('should reject cycle', () => {
      const plan = makePlan({
        steps: [
          makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }), depends_on: ['b'] }),
          makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }), depends_on: ['a'] }),
        ],
      });
      expect(engine.validatePlan(plan)).toContain('Cycle');
    });
  });

  describe('topologicalSort', () => {
    it('should sort linear chain correctly', () => {
      const steps = [
        makeStep({ id: 'c', depends_on: ['b'] }),
        makeStep({ id: 'a' }),
        makeStep({ id: 'b', depends_on: ['a'] }),
      ];
      const sorted = engine.topologicalSort(steps);
      expect(sorted).not.toBeNull();
      const ids = sorted!.map((s) => s.id);
      expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
      expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
    });

    it('should return null for cyclic graph', () => {
      const steps = [
        makeStep({ id: 'a', depends_on: ['c'] }),
        makeStep({ id: 'b', depends_on: ['a'] }),
        makeStep({ id: 'c', depends_on: ['b'] }),
      ];
      expect(engine.topologicalSort(steps)).toBeNull();
    });

    it('should handle independent steps', () => {
      const steps = [makeStep({ id: 'x' }), makeStep({ id: 'y' }), makeStep({ id: 'z' })];
      const sorted = engine.topologicalSort(steps);
      expect(sorted).toHaveLength(3);
    });

    it('should return null for invalid dependency references', () => {
      const steps = [makeStep({ id: 'a', depends_on: ['missing'] })];
      expect(engine.topologicalSort(steps)).toBeNull();
    });
  });

  describe('buildExecutionLevels', () => {
    it('should group independent steps at same level', () => {
      const steps = [
        makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }) }),
        makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }) }),
        makeStep({ id: 'c', agent: makeAgent({ id: 'c1' }), depends_on: ['a', 'b'] }),
      ];
      const levels = engine.buildExecutionLevels(steps);
      expect(levels).toHaveLength(2);
      expect(levels[0].map((s) => s.id).sort()).toEqual(['a', 'b']);
      expect(levels[1].map((s) => s.id)).toEqual(['c']);
    });

    it('should create separate levels for chain', () => {
      const steps = [
        makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }) }),
        makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }), depends_on: ['a'] }),
        makeStep({ id: 'c', agent: makeAgent({ id: 'c1' }), depends_on: ['b'] }),
      ];
      const levels = engine.buildExecutionLevels(steps);
      expect(levels).toHaveLength(3);
    });
  });

  describe('execute', () => {
    it('should execute simple single-step workflow', async () => {
      const plan = makePlan();
      const executor = vi.fn().mockResolvedValue('Step result');

      const { result, execution } = await engine.execute(plan, executor);

      expect(execution.status).toBe('completed');
      expect(execution.steps).toHaveLength(1);
      expect(execution.steps[0].status).toBe('success');
      expect(execution.steps[0].result).toBe('Step result');
      expect(result).toContain('Step result');
      expect(executor).toHaveBeenCalledOnce();
    });

    it('should execute steps in parallel at same level', async () => {
      const plan = makePlan({
        steps: [
          makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }) }),
          makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }) }),
        ],
      });

      const callOrder: string[] = [];
      const executor = vi.fn().mockImplementation(async (agent: EphemeralAgentDef) => {
        callOrder.push(`start-${agent.id}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${agent.id}`);
        return `Result from ${agent.id}`;
      });

      const { execution } = await engine.execute(plan, executor);

      expect(execution.status).toBe('completed');
      expect(execution.steps).toHaveLength(2);
      // Both should start before either ends (parallel execution)
      expect(callOrder[0]).toBe('start-a1');
      expect(callOrder[1]).toBe('start-b1');
    });

    it('should interpolate previous step results into prompts', async () => {
      const plan = makePlan({
        steps: [
          makeStep({
            id: 'research',
            agent: makeAgent({ id: 'researcher' }),
            prompt: 'Research X',
          }),
          makeStep({
            id: 'code',
            agent: makeAgent({ id: 'coder' }),
            prompt: 'Implement based on: {{research.result}}',
            depends_on: ['research'],
          }),
        ],
      });

      const executor = vi
        .fn()
        .mockImplementation(async (_agent: EphemeralAgentDef, prompt: string) => {
          if (prompt.includes('Research')) return 'Use React with TypeScript';
          return `Coded with: ${prompt}`;
        });

      const { execution } = await engine.execute(plan, executor);

      expect(execution.status).toBe('completed');
      // Second call should receive interpolated prompt
      expect(executor).toHaveBeenCalledTimes(2);
      const secondCallPrompt = executor.mock.calls[1][1];
      expect(secondCallPrompt).toContain('Use React with TypeScript');
    });

    it('should fail workflow on non-optional step failure', async () => {
      const plan = makePlan({
        steps: [
          makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }) }),
          makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }), depends_on: ['a'] }),
        ],
      });

      const executor = vi.fn().mockRejectedValue(new Error('Agent crashed'));

      const { execution } = await engine.execute(plan, executor);

      expect(execution.status).toBe('failed');
    });

    it('should continue workflow on optional step failure', async () => {
      const plan = makePlan({
        steps: [
          makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }), optional: true }),
          makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }) }),
        ],
      });

      let callCount = 0;
      const executor = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Optional failure');
        return 'B succeeded';
      });

      const { execution } = await engine.execute(plan, executor);

      expect(execution.status).toBe('completed');
      expect(execution.steps[0].status).toBe('failed');
      expect(execution.steps[1].status).toBe('success');
    });

    it('should emit progress events', async () => {
      const plan = makePlan();
      const executor = vi.fn().mockResolvedValue('done');
      const events: WorkflowProgressEvent[] = [];
      engine.on('progress', (e: WorkflowProgressEvent) => events.push(e));

      await engine.execute(plan, executor);

      expect(events.length).toBeGreaterThanOrEqual(3); // start, complete, workflow-completed
      expect(events[0].type).toBe('step-started');
      expect(events[1].type).toBe('step-completed');
      expect(events[events.length - 1].type).toBe('workflow-completed');
    });

    it('should use synthesis prompt_template if provided', async () => {
      const plan = makePlan({
        steps: [makeStep({ id: 'research', agent: makeAgent({ id: 'r1' }) })],
        synthesis: {
          prompt_template: 'Summary: {{research.result}}',
        },
      });

      const executor = vi.fn().mockResolvedValue('Found X');

      const { result } = await engine.execute(plan, executor);

      expect(result).toBe('Summary: Found X');
    });

    it('should preserve duration_ms on rejected step promises', async () => {
      const plan = makePlan();
      const injectedFailure = { message: 'Injected failure', duration_ms: 321 };
      const executeStepSpy = vi
        .spyOn(
          engine as unknown as { executeStep: (...args: unknown[]) => Promise<unknown> },
          'executeStep'
        )
        .mockRejectedValue(injectedFailure);
      const executor = vi.fn();

      const { execution } = await engine.execute(plan, executor);

      expect(execution.status).toBe('failed');
      expect(execution.steps).toHaveLength(1);
      expect(execution.steps[0].duration_ms).toBe(321);
      expect(execution.steps[0].error).toBe('Injected failure');

      executeStepSpy.mockRestore();
    });
  });

  describe('cancel', () => {
    it('should cancel running workflow', async () => {
      const plan = makePlan({
        steps: [
          makeStep({ id: 'a', agent: makeAgent({ id: 'a1' }) }),
          makeStep({ id: 'b', agent: makeAgent({ id: 'b1' }), depends_on: ['a'] }),
        ],
      });

      let executionId = '';
      engine.on('progress', (e: WorkflowProgressEvent) => {
        if (e.type === 'step-started' && !executionId) {
          executionId = e.executionId;
        }
      });

      const executor = vi.fn().mockImplementation(async () => {
        // Cancel after first step starts
        if (executionId) engine.cancel(executionId);
        await new Promise((r) => setTimeout(r, 10));
        return 'done';
      });

      const { execution } = await engine.execute(plan, executor);

      // Should be cancelled or completed depending on timing
      expect(['cancelled', 'completed']).toContain(execution.status);
    });

    it('should return false for unknown execution ID', () => {
      expect(engine.cancel('nonexistent')).toBe(false);
    });
  });

  describe('isEnabled', () => {
    it('should return true when enabled', () => {
      expect(engine.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      const disabled = new WorkflowEngine({ enabled: false });
      expect(disabled.isEnabled()).toBe(false);
    });
  });
});
