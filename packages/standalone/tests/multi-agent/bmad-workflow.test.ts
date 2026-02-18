/**
 * Tests for BMAD workflow_plan DAG validation
 *
 * Verifies that the BMAD workflow templates produce valid
 * WorkflowEngine-compatible plans.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/multi-agent/workflow-engine.js';
import type {
  WorkflowPlan,
  WorkflowConfig,
  EphemeralAgentDef,
} from '../../src/multi-agent/workflow-types.js';

process.env.MAMA_FORCE_TIER_3 = 'true';

function makeAgent(overrides: Partial<EphemeralAgentDef> = {}): EphemeralAgentDef {
  return {
    id: 'bmad-agent',
    display_name: 'BMAD Agent',
    backend: 'claude',
    model: 'claude-sonnet-4-5-20250929',
    system_prompt: 'You are a BMAD planning agent.',
    ...overrides,
  };
}

const defaultConfig: WorkflowConfig = {
  enabled: true,
  max_ephemeral_agents: 5,
  max_duration_ms: 600000,
};

describe('BMAD Workflow Plans', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(defaultConfig);
  });

  describe('Brainstorm workflow', () => {
    const brainstormPlan: WorkflowPlan = {
      name: 'BMAD Brainstorm: Feature Ideation',
      steps: [
        {
          id: 'perspective-tech',
          agent: makeAgent({
            id: 'tech-perspective-1',
            display_name: '🔧 Tech Analyst',
            system_prompt:
              'You are a technical expert. Analyze from engineering feasibility, scalability, and implementation complexity perspectives.',
          }),
          prompt: 'Analyze technical feasibility for: Add real-time collaboration to MAMA',
        },
        {
          id: 'perspective-product',
          agent: makeAgent({
            id: 'product-perspective-1',
            display_name: '📊 Product Analyst',
            system_prompt:
              'You are a product strategist. Analyze from user value, market fit, and business impact perspectives.',
          }),
          prompt: 'Analyze product value for: Add real-time collaboration to MAMA',
        },
        {
          id: 'synthesize',
          agent: makeAgent({
            id: 'synthesizer-1',
            display_name: '📝 Doc Writer',
            system_prompt:
              'You are a document synthesizer. Combine all perspectives into a structured brainstorm document.',
          }),
          prompt:
            'Synthesize perspectives:\n\nTech: {{perspective-tech.result}}\n\nProduct: {{perspective-product.result}}\n\nWrite the result to docs/brainstorm-mama-2026-02-18.md',
          depends_on: ['perspective-tech', 'perspective-product'],
        },
      ],
    };

    it('should pass validation', () => {
      expect(engine.validatePlan(brainstormPlan)).toBeNull();
    });

    it('should parse from conductor response', () => {
      const response = `[PLAN] Brainstorm workflow for feature ideation.\n\n\`\`\`workflow_plan\n${JSON.stringify(brainstormPlan)}\n\`\`\`\n\nStarting parallel analysis.`;
      const parsed = engine.parseWorkflowPlan(response);
      expect(parsed).not.toBeNull();
      expect(parsed!.steps).toHaveLength(3);
    });

    it('should have correct DAG levels (parallel + sequential)', () => {
      const levels = engine.buildExecutionLevels(brainstormPlan.steps);
      expect(levels).toHaveLength(2);
      // Level 0: parallel perspectives
      expect(levels[0].map((s) => s.id).sort()).toEqual([
        'perspective-product',
        'perspective-tech',
      ]);
      // Level 1: synthesize
      expect(levels[1].map((s) => s.id)).toEqual(['synthesize']);
    });

    it('should include result interpolation in synthesize step', () => {
      const synthStep = brainstormPlan.steps.find((s) => s.id === 'synthesize');
      expect(synthStep!.prompt).toContain('{{perspective-tech.result}}');
      expect(synthStep!.prompt).toContain('{{perspective-product.result}}');
    });
  });

  describe('PRD workflow', () => {
    const prdPlan: WorkflowPlan = {
      name: 'BMAD PRD: User Authentication',
      steps: [
        {
          id: 'research',
          agent: makeAgent({
            id: 'researcher-1',
            display_name: '🔍 Researcher',
            system_prompt: 'You are a technical researcher.',
          }),
          prompt: 'Research authentication patterns, competitors, and user needs.',
        },
        {
          id: 'requirements',
          agent: makeAgent({
            id: 'pm-1',
            display_name: '📋 Product Manager',
            system_prompt: 'You are a product manager. Define requirements in PRD format.',
          }),
          prompt:
            'Based on research: {{research.result}}\n\nDefine functional and non-functional requirements.',
          depends_on: ['research'],
        },
        {
          id: 'write-doc',
          agent: makeAgent({
            id: 'writer-1',
            display_name: '📝 Doc Writer',
            system_prompt: 'You are a technical writer.',
          }),
          prompt:
            'Write the final PRD document to docs/prd-mama-2026-02-18.md\n\nRequirements: {{requirements.result}}\n\nInclude: Overview, Goals, User Stories, Requirements, Success Metrics.',
          depends_on: ['requirements'],
        },
      ],
    };

    it('should pass validation', () => {
      expect(engine.validatePlan(prdPlan)).toBeNull();
    });

    it('should be a sequential DAG (3 levels)', () => {
      const levels = engine.buildExecutionLevels(prdPlan.steps);
      expect(levels).toHaveLength(3);
      expect(levels[0][0].id).toBe('research');
      expect(levels[1][0].id).toBe('requirements');
      expect(levels[2][0].id).toBe('write-doc');
    });

    it('should chain result interpolation', () => {
      expect(prdPlan.steps[1].prompt).toContain('{{research.result}}');
      expect(prdPlan.steps[2].prompt).toContain('{{requirements.result}}');
    });

    it('write-doc step should reference output path', () => {
      const writeStep = prdPlan.steps.find((s) => s.id === 'write-doc');
      expect(writeStep!.prompt).toMatch(/docs\/prd-.*\.md/);
    });
  });

  describe('Architecture workflow', () => {
    const archPlan: WorkflowPlan = {
      name: 'BMAD Architecture: Microservice Migration',
      steps: [
        {
          id: 'analyze',
          agent: makeAgent({
            id: 'analyst-1',
            display_name: '🔍 System Analyst',
            system_prompt: 'You are a system analyst.',
          }),
          prompt: 'Analyze current monolith architecture and constraints.',
        },
        {
          id: 'design',
          agent: makeAgent({
            id: 'architect-1',
            display_name: '🏗️ Architect',
            system_prompt: 'You are a system architect.',
          }),
          prompt:
            'Design microservice architecture based on: {{analyze.result}}\n\nInclude: components, data flow, tech stack, APIs.',
          depends_on: ['analyze'],
        },
        {
          id: 'review',
          agent: makeAgent({
            id: 'reviewer-1',
            display_name: '🔒 Security Reviewer',
            system_prompt: 'You are a security and scalability reviewer.',
          }),
          prompt: 'Review architecture for risks: {{design.result}}',
          depends_on: ['design'],
          optional: true,
        },
        {
          id: 'write-doc',
          agent: makeAgent({
            id: 'writer-1',
            display_name: '📝 Doc Writer',
            system_prompt: 'You are a technical writer.',
          }),
          prompt:
            'Write the architecture document to docs/architecture-mama-2026-02-18.md\n\nDesign: {{design.result}}\nReview: {{review.result}}',
          depends_on: ['design', 'review'],
        },
      ],
    };

    it('should pass validation', () => {
      expect(engine.validatePlan(archPlan)).toBeNull();
    });

    it('should have review as optional step', () => {
      const reviewStep = archPlan.steps.find((s) => s.id === 'review');
      expect(reviewStep!.optional).toBe(true);
    });

    it('should have correct DAG levels', () => {
      const levels = engine.buildExecutionLevels(archPlan.steps);
      expect(levels).toHaveLength(4);
      expect(levels[0][0].id).toBe('analyze');
      expect(levels[1][0].id).toBe('design');
      expect(levels[2][0].id).toBe('review');
      expect(levels[3][0].id).toBe('write-doc');
    });
  });

  describe('Sprint Planning workflow', () => {
    const sprintPlan: WorkflowPlan = {
      name: 'BMAD Sprint: Q1 Planning',
      steps: [
        {
          id: 'epic-breakdown',
          agent: makeAgent({
            id: 'scrum-1',
            display_name: '📋 Scrum Master',
            system_prompt: 'You are a scrum master. Break down features into epics and stories.',
          }),
          prompt:
            'Break down into epics and user stories with acceptance criteria: Implement user dashboard',
        },
        {
          id: 'write-sprint',
          agent: makeAgent({
            id: 'writer-1',
            display_name: '📝 Sprint Writer',
            system_prompt: 'You are a sprint documentation writer.',
          }),
          prompt:
            'Write sprint plan to docs/sprint-plan-mama-2026-02-18.md\n\nEpics: {{epic-breakdown.result}}\n\nAlso create docs/sprint-status.yaml with story status tracking.',
          depends_on: ['epic-breakdown'],
        },
      ],
    };

    it('should pass validation', () => {
      expect(engine.validatePlan(sprintPlan)).toBeNull();
    });

    it('should be a 2-step sequential DAG', () => {
      const levels = engine.buildExecutionLevels(sprintPlan.steps);
      expect(levels).toHaveLength(2);
      expect(levels[0][0].id).toBe('epic-breakdown');
      expect(levels[1][0].id).toBe('write-sprint');
    });

    it('write-sprint should reference sprint-status.yaml', () => {
      const writeStep = sprintPlan.steps.find((s) => s.id === 'write-sprint');
      expect(writeStep!.prompt).toContain('sprint-status.yaml');
    });
  });

  describe('Edge cases', () => {
    it('should reject plan exceeding max ephemeral agents', () => {
      const restrictedEngine = new WorkflowEngine({
        enabled: true,
        max_ephemeral_agents: 2,
      });

      const plan: WorkflowPlan = {
        name: 'Too Many Steps',
        steps: [
          { id: 'a', agent: makeAgent({ id: 'a1' }), prompt: 'do a' },
          { id: 'b', agent: makeAgent({ id: 'b1' }), prompt: 'do b' },
          { id: 'c', agent: makeAgent({ id: 'c1' }), prompt: 'do c' },
        ],
      };

      const error = restrictedEngine.validatePlan(plan);
      expect(error).toContain('Too many steps');
    });

    it('should reject plan with cycle', () => {
      const plan: WorkflowPlan = {
        name: 'Cyclic',
        steps: [
          {
            id: 'a',
            agent: makeAgent({ id: 'a1' }),
            prompt: 'a',
            depends_on: ['b'],
          },
          {
            id: 'b',
            agent: makeAgent({ id: 'b1' }),
            prompt: 'b',
            depends_on: ['a'],
          },
        ],
      };

      const error = engine.validatePlan(plan);
      expect(error).toContain('Cycle');
    });

    it('should reject plan with unknown dependency', () => {
      const plan: WorkflowPlan = {
        name: 'Bad Dep',
        steps: [
          {
            id: 'a',
            agent: makeAgent({ id: 'a1' }),
            prompt: 'a',
            depends_on: ['nonexistent'],
          },
        ],
      };

      const error = engine.validatePlan(plan);
      expect(error).toContain('unknown step');
    });
  });
});
