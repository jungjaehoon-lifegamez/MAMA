/**
 * Tests for CategoryRouter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CategoryRouter } from '../../src/multi-agent/category-router.js';
import { MultiAgentOrchestrator } from '../../src/multi-agent/orchestrator.js';
import type {
  AgentPersonaConfig,
  CategoryConfig,
  MultiAgentConfig,
  MessageContext,
} from '../../src/multi-agent/types.js';

function makeAgent(overrides: Partial<AgentPersonaConfig> = {}): AgentPersonaConfig {
  return {
    id: 'test',
    name: 'Test',
    display_name: 'Test',
    trigger_prefix: '!test',
    persona_file: '~/.mama/personas/test.md',
    ...overrides,
  };
}

describe('CategoryRouter', () => {
  let router: CategoryRouter;

  const agents: AgentPersonaConfig[] = [
    makeAgent({ id: 'developer', name: 'Developer', display_name: '🔧 Developer' }),
    makeAgent({ id: 'reviewer', name: 'Reviewer', display_name: '📝 Reviewer' }),
    makeAgent({ id: 'pm', name: 'PM', display_name: '📋 PM' }),
  ];

  const categories: CategoryConfig[] = [
    {
      name: 'code_review',
      patterns: ['리뷰해줘', 'review\\s+this', 'PR\\s*#?\\d+'],
      agent_ids: ['reviewer'],
      priority: 10,
    },
    {
      name: 'implementation',
      patterns: ['구현해줘', 'implement\\s+', 'build\\s+a\\s+'],
      agent_ids: ['developer'],
      priority: 5,
    },
    {
      name: 'planning',
      patterns: ['계획.*세워', 'plan\\s+the\\s+', 'roadmap'],
      agent_ids: ['pm'],
      priority: 0,
    },
  ];

  beforeEach(() => {
    router = new CategoryRouter(categories);
  });

  describe('route', () => {
    it('should match English regex patterns', () => {
      const result = router.route('Can you review this code?', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('code_review');
      expect(result!.agentIds).toEqual(['reviewer']);
    });

    it('should match Korean patterns', () => {
      const result = router.route('이 코드 리뷰해줘', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('code_review');
      expect(result!.agentIds).toEqual(['reviewer']);
    });

    it('should match implementation patterns', () => {
      const result = router.route('Please implement the login feature', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('implementation');
      expect(result!.agentIds).toEqual(['developer']);
    });

    it('should match Korean implementation patterns', () => {
      const result = router.route('로그인 기능 구현해줘', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('implementation');
    });

    it('should match planning patterns', () => {
      const result = router.route('Let me plan the sprint', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('planning');
      expect(result!.agentIds).toEqual(['pm']);
    });

    it('should match PR number patterns', () => {
      const result = router.route('Check PR #42', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('code_review');
    });

    it('should return null when no pattern matches', () => {
      const result = router.route('Hello there!', agents);
      expect(result).toBeNull();
    });

    it('should respect priority (higher priority matched first)', () => {
      // Create categories where both could match
      const overlapping: CategoryConfig[] = [
        {
          name: 'low_priority',
          patterns: ['test'],
          agent_ids: ['developer'],
          priority: 1,
        },
        {
          name: 'high_priority',
          patterns: ['test'],
          agent_ids: ['reviewer'],
          priority: 10,
        },
      ];

      const r = new CategoryRouter(overlapping);
      const result = r.route('test message', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('high_priority');
      expect(result!.agentIds).toEqual(['reviewer']);
    });

    it('should filter to only available agents', () => {
      // Only developer is available
      const limited = [agents[0]]; // developer only
      const result = router.route('이 코드 리뷰해줘', limited);
      // reviewer is not available, so even though pattern matches, no agents returned
      expect(result).toBeNull();
    });

    it('should return matched pattern', () => {
      const result = router.route('review this code', agents);
      expect(result).not.toBeNull();
      expect(result!.matchedPattern).toBe('review\\s+this');
    });

    it('should be case-insensitive', () => {
      const result = router.route('REVIEW THIS code', agents);
      expect(result).not.toBeNull();
      expect(result!.categoryName).toBe('code_review');
    });

    it('should handle invalid regex gracefully', () => {
      const badCategories: CategoryConfig[] = [
        {
          name: 'bad',
          patterns: ['[invalid regex'],
          agent_ids: ['developer'],
        },
      ];

      const r = new CategoryRouter(badCategories);
      const result = r.route('test', agents);
      expect(result).toBeNull(); // Should not crash
    });
  });

  describe('updateCategories', () => {
    it('should update categories and clear regex cache', () => {
      // First, match against old categories
      expect(router.route('review this code', agents)).not.toBeNull();

      // Update to new categories with different patterns
      router.updateCategories([
        {
          name: 'new_category',
          patterns: ['new_pattern'],
          agent_ids: ['pm'],
        },
      ]);

      // Old pattern should no longer match
      expect(router.route('review this code', agents)).toBeNull();
      // New pattern should match
      expect(router.route('new_pattern here', agents)).not.toBeNull();
    });
  });

  describe('getCategories', () => {
    it('should return sorted copy of categories', () => {
      const cats = router.getCategories();
      expect(cats.length).toBe(3);
      // Should be sorted by priority (highest first)
      expect(cats[0].name).toBe('code_review'); // priority 10
      expect(cats[1].name).toBe('implementation'); // priority 5
      expect(cats[2].name).toBe('planning'); // priority 0
    });
  });
});

describe('CategoryRouter integration with Orchestrator', () => {
  it('should use category_match before keyword_match', () => {
    const config: MultiAgentConfig = {
      enabled: true,
      agents: {
        developer: {
          name: 'Developer',
          display_name: '🔧 Developer',
          trigger_prefix: '!dev',
          persona_file: '~/.mama/personas/dev.md',
          auto_respond_keywords: ['code', 'build'],
          cooldown_ms: 1000,
        },
        reviewer: {
          name: 'Reviewer',
          display_name: '📝 Reviewer',
          trigger_prefix: '!review',
          persona_file: '~/.mama/personas/reviewer.md',
          auto_respond_keywords: ['review'],
          cooldown_ms: 1000,
        },
      },
      loop_prevention: {
        max_chain_length: 3,
        global_cooldown_ms: 500,
        chain_window_ms: 60000,
      },
      categories: [
        {
          name: 'code_review',
          patterns: ['리뷰해줘'],
          agent_ids: ['reviewer'],
          priority: 10,
        },
      ],
    };

    const orchestrator = new MultiAgentOrchestrator(config);

    // Korean review pattern should match via category, not keyword
    const context: MessageContext = {
      channelId: 'ch1',
      userId: 'user1',
      content: '이 코드 리뷰해줘',
      isBot: false,
      timestamp: Date.now(),
    };

    const result = orchestrator.selectRespondingAgents(context);
    expect(result.selectedAgents).toEqual(['reviewer']);
    expect(result.reason).toBe('category_match');
  });

  it('should fall through to keyword_match if no category matches', () => {
    const config: MultiAgentConfig = {
      enabled: true,
      agents: {
        developer: {
          name: 'Developer',
          display_name: '🔧 Developer',
          trigger_prefix: '!dev',
          persona_file: '~/.mama/personas/dev.md',
          auto_respond_keywords: ['bug'],
          cooldown_ms: 1000,
        },
      },
      loop_prevention: {
        max_chain_length: 3,
        global_cooldown_ms: 500,
        chain_window_ms: 60000,
      },
      categories: [
        {
          name: 'review',
          patterns: ['review'],
          agent_ids: ['reviewer'],
        },
      ],
    };

    const orchestrator = new MultiAgentOrchestrator(config);

    const context: MessageContext = {
      channelId: 'ch1',
      userId: 'user1',
      content: 'Found a bug in the code',
      isBot: false,
      timestamp: Date.now(),
    };

    const result = orchestrator.selectRespondingAgents(context);
    expect(result.selectedAgents).toEqual(['developer']);
    expect(result.reason).toBe('keyword_match');
  });

  it('should prefer explicit_trigger over category_match', () => {
    const config: MultiAgentConfig = {
      enabled: true,
      agents: {
        developer: {
          name: 'Developer',
          display_name: '🔧 Developer',
          trigger_prefix: '!dev',
          persona_file: '~/.mama/personas/dev.md',
          cooldown_ms: 1000,
        },
        reviewer: {
          name: 'Reviewer',
          display_name: '📝 Reviewer',
          trigger_prefix: '!review',
          persona_file: '~/.mama/personas/reviewer.md',
          cooldown_ms: 1000,
        },
      },
      loop_prevention: {
        max_chain_length: 3,
        global_cooldown_ms: 500,
        chain_window_ms: 60000,
      },
      categories: [
        {
          name: 'review',
          patterns: ['review'],
          agent_ids: ['reviewer'],
        },
      ],
    };

    const orchestrator = new MultiAgentOrchestrator(config);

    // Explicit trigger "!dev" should win over category match for "review"
    const context: MessageContext = {
      channelId: 'ch1',
      userId: 'user1',
      content: '!dev review this code',
      isBot: false,
      timestamp: Date.now(),
    };

    const result = orchestrator.selectRespondingAgents(context);
    expect(result.selectedAgents).toEqual(['developer']);
    expect(result.reason).toBe('explicit_trigger');
  });

  it('should not break existing orchestrator tests (backward compat without categories)', () => {
    const config: MultiAgentConfig = {
      enabled: true,
      agents: {
        developer: {
          name: 'DevBot',
          display_name: '🔧 DevBot',
          trigger_prefix: '!dev',
          persona_file: '~/.mama/personas/dev.md',
          auto_respond_keywords: ['bug'],
          cooldown_ms: 1000,
        },
      },
      loop_prevention: {
        max_chain_length: 3,
        global_cooldown_ms: 500,
        chain_window_ms: 60000,
      },
      // No categories defined
    };

    const orchestrator = new MultiAgentOrchestrator(config);

    const context: MessageContext = {
      channelId: 'ch1',
      userId: 'user1',
      content: 'Found a bug',
      isBot: false,
      timestamp: Date.now(),
    };

    const result = orchestrator.selectRespondingAgents(context);
    expect(result.selectedAgents).toEqual(['developer']);
    expect(result.reason).toBe('keyword_match');
  });
});
