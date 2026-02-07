/**
 * Tests for Slack @Mention-based Agent Delegation
 *
 * Tests the Slack extension of mention_delegation:
 * - SlackMultiBotManager: bot identity, mention routing
 * - Slack token types: slack_bot_token, slack_app_token
 * - Platform-neutral prompt text
 * - Backward compatibility
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolPermissionManager } from '../../src/multi-agent/tool-permission-manager.js';
import { SlackMultiBotManager } from '../../src/multi-agent/slack-multi-bot-manager.js';
import type { AgentPersonaConfig, MultiAgentConfig } from '../../src/multi-agent/types.js';

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
        slack_bot_token: 'xoxb-lead-token',
        slack_app_token: 'xapp-lead-token',
      },
      developer: {
        name: 'Developer',
        display_name: '🔧 Developer',
        trigger_prefix: '!dev',
        persona_file: '~/.mama/personas/dev.md',
        tier: 1,
        bot_token: 'token-dev',
        slack_bot_token: 'xoxb-dev-token',
        slack_app_token: 'xapp-dev-token',
      },
      reviewer: {
        name: 'Reviewer',
        display_name: '📝 Reviewer',
        trigger_prefix: '!review',
        persona_file: '~/.mama/personas/review.md',
        tier: 2,
        bot_token: 'token-review',
        slack_bot_token: 'xoxb-review-token',
        slack_app_token: 'xapp-review-token',
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

describe('Slack Mention Delegation', () => {
  describe('Slack token type definitions', () => {
    it('should accept slack_bot_token and slack_app_token in agent config', () => {
      const agent = makeAgent({
        slack_bot_token: 'xoxb-123',
        slack_app_token: 'xapp-456',
      });
      expect(agent.slack_bot_token).toBe('xoxb-123');
      expect(agent.slack_app_token).toBe('xapp-456');
    });

    it('should allow agents without Slack tokens', () => {
      const agent = makeAgent();
      expect(agent.slack_bot_token).toBeUndefined();
      expect(agent.slack_app_token).toBeUndefined();
    });

    it('should allow agent with Discord bot_token but no Slack tokens', () => {
      const agent = makeAgent({ bot_token: 'discord-token-123' });
      expect(agent.bot_token).toBe('discord-token-123');
      expect(agent.slack_bot_token).toBeUndefined();
    });

    it('should allow agent with both Discord and Slack tokens', () => {
      const agent = makeAgent({
        bot_token: 'discord-token',
        slack_bot_token: 'xoxb-slack',
        slack_app_token: 'xapp-slack',
      });
      expect(agent.bot_token).toBe('discord-token');
      expect(agent.slack_bot_token).toBe('xoxb-slack');
      expect(agent.slack_app_token).toBe('xapp-slack');
    });
  });

  describe('SlackMultiBotManager basic operations', () => {
    let manager: SlackMultiBotManager;

    beforeEach(() => {
      manager = new SlackMultiBotManager(makeConfig());
    });

    it('should have getBotUserIdMap method returning empty map initially', () => {
      expect(typeof manager.getBotUserIdMap).toBe('function');
      const map = manager.getBotUserIdMap();
      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBe(0);
    });

    it('should have resolveAgentIdFromUserId method', () => {
      expect(typeof manager.resolveAgentIdFromUserId).toBe('function');
      expect(manager.resolveAgentIdFromUserId('unknown')).toBeNull();
    });

    it('should resolve main bot user ID', () => {
      manager.setMainBotUserId('U_MAIN_BOT');
      expect(manager.resolveAgentIdFromUserId('U_MAIN_BOT')).toBe('main');
    });

    it('should return null for unknown user ID', () => {
      expect(manager.resolveAgentIdFromUserId('U_UNKNOWN')).toBeNull();
    });

    it('should have getConnectedAgents returning empty initially', () => {
      expect(manager.getConnectedAgents()).toEqual([]);
    });

    it('should have getStatus returning empty initially', () => {
      expect(manager.getStatus()).toEqual({});
    });
  });

  describe('SlackMultiBotManager.isFromAgentBot', () => {
    let manager: SlackMultiBotManager;

    beforeEach(() => {
      manager = new SlackMultiBotManager(makeConfig());
    });

    it('should return "main" for main bot ID', () => {
      manager.setMainBotId('B_MAIN');
      expect(manager.isFromAgentBot('B_MAIN')).toBe('main');
    });

    it('should return null for unknown bot ID', () => {
      expect(manager.isFromAgentBot('B_UNKNOWN')).toBeNull();
    });

    it('should return null when no main bot ID is set', () => {
      expect(manager.isFromAgentBot('B_ANY')).toBeNull();
    });
  });

  describe('Mention extraction (Slack <@U...> format)', () => {
    it('should parse Slack user mentions from text', () => {
      // This tests the regex pattern used in MultiAgentSlackHandler
      const mentionPattern = /<@([UW]\w+)>/g;
      const text = 'Hey <@U012AB3CD> please review this code <@U456DEF78>';
      const matches: string[] = [];
      let match;

      while ((match = mentionPattern.exec(text)) !== null) {
        matches.push(match[1]);
      }

      expect(matches).toEqual(['U012AB3CD', 'U456DEF78']);
    });

    it('should parse workspace-level mentions (W prefix)', () => {
      const mentionPattern = /<@([UW]\w+)>/g;
      const text = 'Hello <@W012AB3CD>';
      const matches: string[] = [];
      let match;

      while ((match = mentionPattern.exec(text)) !== null) {
        matches.push(match[1]);
      }

      expect(matches).toEqual(['W012AB3CD']);
    });

    it('should return empty for text without mentions', () => {
      const mentionPattern = /<@([UW]\w+)>/g;
      const text = 'Hello world, no mentions here';
      const matches: string[] = [];
      let match;

      while ((match = mentionPattern.exec(text)) !== null) {
        matches.push(match[1]);
      }

      expect(matches).toEqual([]);
    });
  });

  describe('Platform-neutral prompt text', () => {
    let permManager: ToolPermissionManager;

    beforeEach(() => {
      permManager = new ToolPermissionManager();
    });

    it('should NOT contain "Discord" in mention delegation prompt', () => {
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const allAgents: AgentPersonaConfig[] = [
        agent,
        makeAgent({ id: 'dev', name: 'Dev', display_name: 'Dev' }),
      ];
      const botUserIdMap = new Map([
        ['lead', 'U111'],
        ['dev', 'U222'],
      ]);

      const prompt = permManager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);

      expect(prompt).not.toContain('Discord');
      expect(prompt).toContain('@mention format');
      expect(prompt).toContain('Delegation via @Mention');
    });

    it('should use <@USER_ID> format in prompt (works for both Discord and Slack)', () => {
      const agent = makeAgent({ id: 'lead', tier: 1, can_delegate: true });
      const allAgents: AgentPersonaConfig[] = [
        agent,
        makeAgent({ id: 'dev', name: 'Dev', display_name: 'Dev' }),
      ];
      const botUserIdMap = new Map([
        ['lead', 'U111'],
        ['dev', 'U222'],
      ]);

      const prompt = permManager.buildMentionDelegationPrompt(agent, allAgents, botUserIdMap);

      expect(prompt).toContain('<@U222>');
    });
  });

  describe('Backward compatibility', () => {
    it('should work normally without Slack tokens in config', () => {
      const config = makeConfig({
        agents: {
          lead: {
            name: 'Lead',
            display_name: 'Lead',
            trigger_prefix: '!lead',
            persona_file: '~/.mama/personas/lead.md',
            bot_token: 'discord-only-token',
            // No slack_bot_token or slack_app_token
          },
        },
      });

      const manager = new SlackMultiBotManager(config);
      expect(manager.getBotUserIdMap().size).toBe(0);
      expect(manager.getConnectedAgents()).toEqual([]);
    });

    it('should ignore agents with only slack_bot_token but no slack_app_token', () => {
      const config = makeConfig({
        agents: {
          incomplete: {
            name: 'Incomplete',
            display_name: 'Incomplete',
            trigger_prefix: '!inc',
            persona_file: '~/.mama/personas/inc.md',
            slack_bot_token: 'xoxb-has-bot',
            // Missing slack_app_token
          },
        },
      });

      const manager = new SlackMultiBotManager(config);
      // Should not crash, should just not connect
      expect(manager.getBotUserIdMap().size).toBe(0);
    });

    it('config with mention_delegation still works for Slack manager', () => {
      const config = makeConfig({
        mention_delegation: true,
        max_mention_depth: 5,
      });

      expect(config.mention_delegation).toBe(true);
      expect(config.max_mention_depth).toBe(5);

      const manager = new SlackMultiBotManager(config);
      expect(manager.getBotUserIdMap().size).toBe(0);
    });
  });

  describe('SlackMultiBotManager onMention callback', () => {
    it('should register onMention callback without error', () => {
      const manager = new SlackMultiBotManager(makeConfig());
      const callback = () => {};
      expect(() => manager.onMention(callback)).not.toThrow();
    });

    it('should have hasAgentBot returning false for unconnected agents', () => {
      const manager = new SlackMultiBotManager(makeConfig());
      expect(manager.hasAgentBot('lead')).toBe(false);
      expect(manager.hasAgentBot('nonexistent')).toBe(false);
    });
  });

  describe('SlackMultiBotManager stopAll', () => {
    it('should not throw when stopping with no bots', async () => {
      const manager = new SlackMultiBotManager(makeConfig());
      await expect(manager.stopAll()).resolves.toBeUndefined();
    });
  });
});
