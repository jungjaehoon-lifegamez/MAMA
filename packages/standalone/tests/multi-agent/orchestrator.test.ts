/**
 * Tests for Multi-Agent Orchestrator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MultiAgentOrchestrator } from '../../src/multi-agent/orchestrator.js';
import type { MultiAgentConfig, MessageContext } from '../../src/multi-agent/types.js';

describe('MultiAgentOrchestrator', () => {
  let orchestrator: MultiAgentOrchestrator;
  let config: MultiAgentConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      agents: {
        developer: {
          name: 'DevBot',
          display_name: '🔧 DevBot',
          trigger_prefix: '!dev',
          persona_file: '~/.mama/personas/developer.md',
          auto_respond_keywords: ['bug', 'code', 'implement'],
          cooldown_ms: 1000,
        },
        reviewer: {
          name: 'Reviewer',
          display_name: '📝 Reviewer',
          trigger_prefix: '!review',
          persona_file: '~/.mama/personas/reviewer.md',
          auto_respond_keywords: ['review', 'check'],
          cooldown_ms: 1000,
        },
      },
      loop_prevention: {
        max_chain_length: 3,
        global_cooldown_ms: 500,
        chain_window_ms: 60000,
      },
    };

    orchestrator = new MultiAgentOrchestrator(config);
  });

  describe('selectRespondingAgents', () => {
    it('should return empty when multi-agent is disabled', () => {
      const disabledConfig = { ...config, enabled: false };
      const disabledOrchestrator = new MultiAgentOrchestrator(disabledConfig);

      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: '!dev hello',
        isBot: false,
        timestamp: Date.now(),
      };

      const result = disabledOrchestrator.selectRespondingAgents(context);
      expect(result.selectedAgents).toEqual([]);
      expect(result.reason).toBe('none');
    });

    it('should select agent by explicit trigger prefix', () => {
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: '!dev implement login feature',
        isBot: false,
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      expect(result.selectedAgents).toEqual(['developer']);
      expect(result.reason).toBe('explicit_trigger');
      expect(result.blocked).toBe(false);
    });

    it('should select agent by keyword match', () => {
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'Can you review this please?', // Only matches 'review' keyword
        isBot: false,
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      expect(result.selectedAgents).toEqual(['reviewer']);
      expect(result.reason).toBe('keyword_match');
    });

    it('should match multiple agents by keywords', () => {
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'review this bug fix code',
        isBot: false,
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      // Both 'bug' (developer) and 'review' (reviewer) match
      expect(result.selectedAgents.length).toBeGreaterThanOrEqual(1);
      expect(result.reason).toBe('keyword_match');
    });

    it('should limit auto keyword responders for non-bot messages when free_chat is disabled', () => {
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'review this bug fix code',
        isBot: false,
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      expect(result.reason).toBe('keyword_match');
      expect(result.selectedAgents).toEqual(['developer']);
    });

    // Story: MA-BOT-KEYWORD
    // Acceptance Criteria:
    // 1. Bot messages should match all keyword-matching agents
    // 2. No single-agent limit should apply to bot messages
    it('should not limit auto keyword responders for bot messages', () => {
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'bot1',
        content: 'review this bug fix code',
        isBot: true,
        senderAgentId: undefined,
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      expect(result.reason).toBe('keyword_match');
      expect(result.selectedAgents).toEqual(['developer', 'reviewer']);
    });

    // Story: MA-DEFAULT-AGENT
    // Acceptance Criteria:
    // 1. When default_agent is configured, it should respond to unmatched messages
    // 2. The reason should be 'default_agent'
    it('should use default agent when configured', () => {
      const configWithDefault = {
        ...config,
        default_agent: 'developer',
      };
      const orchestratorWithDefault = new MultiAgentOrchestrator(configWithDefault);

      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'hello there',
        isBot: false,
        timestamp: Date.now(),
      };

      const result = orchestratorWithDefault.selectRespondingAgents(context);
      expect(result.selectedAgents).toEqual(['developer']);
      expect(result.reason).toBe('default_agent');
    });

    // Story: MA-NO-MATCH
    // Acceptance Criteria:
    // 1. When no keywords match and no default_agent is configured, return empty
    // 2. The reason should be 'none'
    it('should return empty when no match and no default', () => {
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'hello there',
        isBot: false,
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      expect(result.selectedAgents).toEqual([]);
      expect(result.reason).toBe('none');
    });
  });

  describe('loop prevention', () => {
    it('should reset chain on human message', () => {
      // Simulate agent responses
      orchestrator.recordAgentResponse('developer', 'channel1');
      orchestrator.recordAgentResponse('reviewer', 'channel1');

      const chainState = orchestrator.getChainState('channel1');
      expect(chainState.length).toBe(2);

      // Human message should reset
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'thanks!',
        isBot: false,
        timestamp: Date.now(),
      };

      orchestrator.selectRespondingAgents(context);
      const resetState = orchestrator.getChainState('channel1');
      expect(resetState.length).toBe(0);
      expect(resetState.blocked).toBe(false);
    });

    it('should block after max chain length', () => {
      // Simulate 3 agent responses (max_chain_length)
      orchestrator.recordAgentResponse('developer', 'channel1');
      orchestrator.recordAgentResponse('reviewer', 'channel1');
      orchestrator.recordAgentResponse('developer', 'channel1');

      const chainState = orchestrator.getChainState('channel1');
      expect(chainState.length).toBe(3);
      expect(chainState.blocked).toBe(true);

      // Next agent selection should be blocked
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'bot1',
        content: 'some response',
        isBot: true,
        senderAgentId: 'reviewer',
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain('Chain limit reached');
    });

    it('should respect global cooldown', async () => {
      // Record a response
      orchestrator.recordAgentResponse('developer', 'channel1');

      // Immediately try to select again (within cooldown)
      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'bot1',
        content: 'review this',
        isBot: true,
        senderAgentId: 'developer',
        timestamp: Date.now(),
      };

      const result = orchestrator.selectRespondingAgents(context);
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain('cooldown');
    });
  });

  describe('agent cooldown', () => {
    it('should respect per-agent cooldown', async () => {
      // Record developer response
      orchestrator.recordAgentResponse('developer', 'channel1');

      // Check if developer is ready immediately
      expect(orchestrator.isAgentReady('developer')).toBe(false);

      // Reviewer should still be ready
      expect(orchestrator.isAgentReady('reviewer')).toBe(true);
    });
  });

  describe('extractAgentIdFromMessage', () => {
    it('should extract agent ID from display name prefix', () => {
      const content = '**🔧 DevBot**: Here is your code...';
      const agentId = orchestrator.extractAgentIdFromMessage(content);
      expect(agentId).toBe('developer');
    });

    it('should extract agent ID from simple name prefix', () => {
      const content = '**Reviewer**: Looks good!';
      const agentId = orchestrator.extractAgentIdFromMessage(content);
      expect(agentId).toBe('reviewer');
    });

    it('should return null for unknown format', () => {
      const content = 'Just a regular message';
      const agentId = orchestrator.extractAgentIdFromMessage(content);
      expect(agentId).toBeNull();
    });
  });

  describe('stripTriggerPrefix', () => {
    it('should strip trigger prefix from message', () => {
      const content = '!dev implement login';
      const stripped = orchestrator.stripTriggerPrefix(content, 'developer');
      expect(stripped).toBe('implement login');
    });

    it('should return original content if no prefix', () => {
      const content = 'implement login';
      const stripped = orchestrator.stripTriggerPrefix(content, 'developer');
      expect(stripped).toBe('implement login');
    });
  });

  describe('getEnabledAgents', () => {
    it('should return only enabled agents', () => {
      const configWithDisabled = {
        ...config,
        agents: {
          ...config.agents,
          pm: {
            name: 'PM',
            display_name: '📋 PM',
            trigger_prefix: '!pm',
            persona_file: '~/.mama/personas/pm.md',
            enabled: false,
          },
        },
      };

      const orchestratorWithDisabled = new MultiAgentOrchestrator(configWithDisabled);
      const enabledAgents = orchestratorWithDisabled.getEnabledAgents();

      expect(enabledAgents.length).toBe(2);
      expect(enabledAgents.map((a) => a.id)).toContain('developer');
      expect(enabledAgents.map((a) => a.id)).toContain('reviewer');
      expect(enabledAgents.map((a) => a.id)).not.toContain('pm');
    });
  });

  describe('channel overrides', () => {
    it('should use channel-specific default agent', () => {
      const configWithOverride: MultiAgentConfig = {
        ...config,
        default_agent: 'developer',
        channel_overrides: {
          channel2: {
            default_agent: 'reviewer',
          },
        },
      };

      const orchestratorWithOverride = new MultiAgentOrchestrator(configWithOverride);

      // Channel 1 should use global default
      const context1: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'hello',
        isBot: false,
        timestamp: Date.now(),
      };

      const result1 = orchestratorWithOverride.selectRespondingAgents(context1);
      expect(result1.selectedAgents).toEqual(['developer']);

      // Channel 2 should use override
      const context2: MessageContext = {
        channelId: 'channel2',
        userId: 'user1',
        content: 'hello',
        isBot: false,
        timestamp: Date.now(),
      };

      const result2 = orchestratorWithOverride.selectRespondingAgents(context2);
      expect(result2.selectedAgents).toEqual(['reviewer']);
    });

    it('should respect disabled agents in channel', () => {
      const configWithOverride: MultiAgentConfig = {
        ...config,
        channel_overrides: {
          channel1: {
            disabled_agents: ['reviewer'],
          },
        },
      };

      const orchestratorWithOverride = new MultiAgentOrchestrator(configWithOverride);

      const context: MessageContext = {
        channelId: 'channel1',
        userId: 'user1',
        content: 'review this code',
        isBot: false,
        timestamp: Date.now(),
      };

      const result = orchestratorWithOverride.selectRespondingAgents(context);
      // Reviewer is disabled, so no match
      expect(result.selectedAgents).not.toContain('reviewer');
    });
  });
});
