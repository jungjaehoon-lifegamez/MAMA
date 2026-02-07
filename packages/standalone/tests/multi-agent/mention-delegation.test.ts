/**
 * Tests for @Mention-based Agent Delegation
 *
 * Tests the mention_delegation feature where agents delegate tasks
 * via Discord @mentions instead of internal DELEGATE:: patterns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolPermissionManager } from '../../src/multi-agent/tool-permission-manager.js';
import { MultiBotManager } from '../../src/multi-agent/multi-bot-manager.js';
import type {
  AgentPersonaConfig,
  MultiAgentConfig,
  MessageContext,
} from '../../src/multi-agent/types.js';

function makeAgent(overrides: Partial<AgentPersonaConfig> = {}): AgentPersonaConfig {
  return {
    id: 'test-agent',
    name: 'TestBot',
    display_name: 'TestBot',
    trigger_prefix: '!test',
    persona_file: '~/.mama/personas/test.md',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<MultiAgentConfig> = {}): MultiAgentConfig {
  return {
    enabled: true,
    agents: {
      lead: {
        name: 'Lead',
        display_name: '🎯 Lead',
        trigger_prefix: '!lead',
        persona_file: '~/.mama/personas/lead.md',
        tier: 1,
        can_delegate: true,
        bot_token: 'token-lead',
      },
      developer: {
        name: 'Developer',
        display_name: '🔧 Developer',
        trigger_prefix: '!dev',
        persona_file: '~/.mama/personas/dev.md',
        tier: 1,
        bot_token: 'token-dev',
      },
      reviewer: {
        name: 'Reviewer',
        display_name: '📝 Reviewer',
        trigger_prefix: '!review',
        persona_file: '~/.mama/personas/review.md',
        tier: 2,
        bot_token: 'token-review',
      },
    },
    loop_prevention: {
      max_chain_length: 3,
      global_cooldown_ms: 2000,
      chain_window_ms: 60000,
    },
    ...overrides,
  };
}

describe('Mention Delegation', () => {
  describe('Type definitions', () => {
    it('should accept mention_delegation in MultiAgentConfig', () => {
      const config = makeConfig({ mention_delegation: true, max_mention_depth: 5 });
      expect(config.mention_delegation).toBe(true);
      expect(config.max_mention_depth).toBe(5);
    });

    it('should default mention_delegation to undefined (falsy)', () => {
      const config = makeConfig();
      expect(config.mention_delegation).toBeUndefined();
    });

    it('should accept mentionedAgentIds in MessageContext', () => {
      const context: MessageContext = {
        channelId: 'ch1',
        userId: 'user1',
        content: 'hello',
        isBot: false,
        mentionedAgentIds: ['developer', 'reviewer'],
        timestamp: Date.now(),
      };
      expect(context.mentionedAgentIds).toEqual(['developer', 'reviewer']);
    });

    it('should accept mention_chain as AgentSelectionResult reason', () => {
      // Type check: 'mention_chain' should be assignable
      const reason: 'mention_chain' | 'none' = 'mention_chain';
      expect(reason).toBe('mention_chain');
    });
  });

  describe('ToolPermissionManager.buildMentionDelegationPrompt', () => {
    let manager: ToolPermissionManager;

    beforeEach(() => {
      manager = new ToolPermissionManager();
    });

    it('should generate prompt with <@USER_ID> format', () => {
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const allAgents: AgentPersonaConfig[] = [
        agent,
        makeAgent({ id: 'developer', name: 'Developer', display_name: '🔧 Developer', tier: 1 }),
        makeAgent({ id: 'reviewer', name: 'Reviewer', display_name: '📝 Reviewer', tier: 2 }),
      ];
      const botUserIdMap = new Map([
        ['lead', '111111'],
        ['developer', '222222'],
        ['reviewer', '333333'],
      ]);

      const prompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);

      expect(prompt).toContain('Delegation via @Mention');
      expect(prompt).toContain('<@222222>');
      expect(prompt).toContain('<@333333>');
      // Should not include self
      expect(prompt).not.toContain('<@111111>');
      expect(prompt).toContain('🔧 Developer');
      expect(prompt).toContain('📝 Reviewer');
    });

    it('should return empty string for non-delegating agent', () => {
      const agent = makeAgent({ id: 'dev', tier: 1, can_delegate: false });
      const allAgents = [agent];
      const botUserIdMap = new Map([['dev', '111']]);

      const prompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);
      expect(prompt).toBe('');
    });

    it('should return empty string for Tier 2 agent even with can_delegate', () => {
      const agent = makeAgent({ id: 'dev', tier: 2, can_delegate: true });
      const allAgents = [agent, makeAgent({ id: 'other' })];
      const botUserIdMap = new Map([
        ['dev', '111'],
        ['other', '222'],
      ]);

      const prompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);
      expect(prompt).toBe('');
    });

    it('should exclude agents without bot user IDs from mention prompt', () => {
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const allAgents: AgentPersonaConfig[] = [
        agent,
        makeAgent({ id: 'dev', name: 'Dev', display_name: 'Dev' }),
        makeAgent({ id: 'reviewer', name: 'Reviewer', display_name: 'Reviewer' }),
      ];
      // Only dev has a bot user ID, reviewer does not
      const botUserIdMap = new Map([
        ['lead', '111'],
        ['dev', '222'],
      ]);

      const prompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);

      expect(prompt).toContain('<@222>');
      expect(prompt).toContain('Dev');
      // Reviewer has no bot user ID, should not appear
      expect(prompt).not.toContain('Reviewer');
    });

    it('should exclude disabled agents', () => {
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const allAgents: AgentPersonaConfig[] = [
        agent,
        makeAgent({
          id: 'active',
          name: 'Active',
          display_name: 'Active',
        }),
        makeAgent({
          id: 'disabled',
          name: 'Disabled',
          display_name: 'Disabled',
          enabled: false,
        }),
      ];
      const botUserIdMap = new Map([
        ['lead', '111'],
        ['active', '222'],
        ['disabled', '333'],
      ]);

      const prompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);

      expect(prompt).toContain('Active');
      expect(prompt).not.toContain('Disabled');
    });

    it('should include "mention only ONE agent" rule', () => {
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const allAgents: AgentPersonaConfig[] = [
        agent,
        makeAgent({ id: 'dev', name: 'Dev', display_name: 'Dev' }),
      ];
      const botUserIdMap = new Map([
        ['lead', '111'],
        ['dev', '222'],
      ]);

      const prompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);
      expect(prompt).toContain('ONE agent');
    });

    it('should return empty when no delegatable agents have bot IDs', () => {
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const allAgents: AgentPersonaConfig[] = [
        agent,
        makeAgent({ id: 'dev', name: 'Dev', display_name: 'Dev' }),
      ];
      // No other agents in the botUserIdMap
      const botUserIdMap = new Map([['lead', '111']]);

      const prompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);
      expect(prompt).toBe('');
    });
  });

  describe('MultiBotManager bot message filter', () => {
    let multiBotManager: MultiBotManager;

    beforeEach(() => {
      multiBotManager = new MultiBotManager(makeConfig());
    });

    it('should have getBotUserIdMap method', () => {
      expect(typeof multiBotManager.getBotUserIdMap).toBe('function');
      const map = multiBotManager.getBotUserIdMap();
      expect(map).toBeInstanceOf(Map);
      // No bots connected yet
      expect(map.size).toBe(0);
    });

    it('should have resolveAgentIdFromUserId method', () => {
      expect(typeof multiBotManager.resolveAgentIdFromUserId).toBe('function');
      // No bots connected
      expect(multiBotManager.resolveAgentIdFromUserId('unknown')).toBeNull();
    });

    it('should resolve main bot user ID', () => {
      multiBotManager.setMainBotUserId('main-bot-123');
      expect(multiBotManager.resolveAgentIdFromUserId('main-bot-123')).toBe('main');
    });

    it('should return null for unknown user ID', () => {
      expect(multiBotManager.resolveAgentIdFromUserId('999999')).toBeNull();
    });
  });

  describe('MultiBotManager.isFromAgentBot', () => {
    let multiBotManager: MultiBotManager;

    beforeEach(() => {
      multiBotManager = new MultiBotManager(makeConfig());
    });

    it('should return "main" for main bot messages', () => {
      multiBotManager.setMainBotUserId('main-bot-id');

      const mockMessage = {
        author: { id: 'main-bot-id', bot: true },
      } as any;

      expect(multiBotManager.isFromAgentBot(mockMessage)).toBe('main');
    });

    it('should return null for non-agent bot messages', () => {
      const mockMessage = {
        author: { id: 'random-bot-id', bot: true },
      } as any;

      expect(multiBotManager.isFromAgentBot(mockMessage)).toBeNull();
    });
  });

  describe('Backward compatibility', () => {
    it('should work normally without mention_delegation config', () => {
      const config = makeConfig();
      // No mention_delegation field
      expect(config.mention_delegation).toBeUndefined();
      expect(config.max_mention_depth).toBeUndefined();

      // MultiBotManager should still function
      const manager = new MultiBotManager(config);
      expect(manager.getBotUserIdMap().size).toBe(0);
    });

    it('should default max_mention_depth to 3 conceptually', () => {
      const config = makeConfig({ mention_delegation: true });
      // max_mention_depth not set, code defaults to 3
      expect(config.max_mention_depth).toBeUndefined();
      // The actual default of 3 is applied in multi-agent-discord.ts runtime logic
    });

    it('DELEGATE pattern fallback: agents without bot_token use old pattern', () => {
      const manager = new ToolPermissionManager();
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const agentWithoutBot = makeAgent({
        id: 'helper',
        name: 'Helper',
        display_name: 'Helper',
      });
      const allAgents = [agent, agentWithoutBot];

      // When botUserIdMap has no entry for helper, buildMentionDelegationPrompt
      // won't include helper. The old buildDelegationPrompt still works.
      const botUserIdMap = new Map([['lead', '111']]);
      const mentionPrompt = manager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);
      // Should be empty since no delegatable agents have bot IDs
      expect(mentionPrompt).toBe('');

      // Old delegation prompt still works
      const delegatePrompt = manager.buildDelegationPrompt(agent, allAgents);
      expect(delegatePrompt).toContain('DELEGATE::');
      expect(delegatePrompt).toContain('Helper');
    });
  });

  describe('Chain depth limiting', () => {
    it('should respect max_mention_depth config value', () => {
      const config = makeConfig({
        mention_delegation: true,
        max_mention_depth: 5,
      });
      expect(config.max_mention_depth).toBe(5);
    });

    it('should support max_mention_depth of 1 (single delegation only)', () => {
      const config = makeConfig({
        mention_delegation: true,
        max_mention_depth: 1,
      });
      expect(config.max_mention_depth).toBe(1);
    });
  });
});
