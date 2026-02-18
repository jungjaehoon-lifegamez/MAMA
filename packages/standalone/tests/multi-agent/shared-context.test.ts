/**
 * Tests for Shared Context Manager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SharedContextManager,
  resetSharedContextManager,
} from '../../src/multi-agent/shared-context.js';
import type { AgentPersonaConfig } from '../../src/multi-agent/types.js';

describe('SharedContextManager', () => {
  let manager: SharedContextManager;

  beforeEach(() => {
    resetSharedContextManager();
    manager = new SharedContextManager({ maxMessages: 10, maxAgeMs: 60000 });
  });

  const mockAgent: AgentPersonaConfig = {
    id: 'developer',
    name: 'DevBot',
    display_name: '🔧 DevBot',
    trigger_prefix: '!dev',
    persona_file: '~/.mama/personas/developer.md',
  };

  const mockReviewer: AgentPersonaConfig = {
    id: 'reviewer',
    name: 'Reviewer',
    display_name: '📝 Reviewer',
    trigger_prefix: '!review',
    persona_file: '~/.mama/personas/reviewer.md',
  };

  describe('recordHumanMessage', () => {
    it('should record human message', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Hello world', 'msg1');

      const messages = manager.getRecentMessages('channel1');
      expect(messages.length).toBe(1);
      expect(messages[0].isHuman).toBe(true);
      expect(messages[0].displayName).toBe('Alice');
      expect(messages[0].content).toBe('Hello world');
      expect(messages[0].agentId).toBeNull();
    });
  });

  describe('recordAgentMessage', () => {
    it('should record agent message', () => {
      manager.recordAgentMessage('channel1', mockAgent, 'Here is the code', 'msg1');

      const messages = manager.getRecentMessages('channel1');
      expect(messages.length).toBe(1);
      expect(messages[0].isHuman).toBe(false);
      expect(messages[0].agentId).toBe('developer');
      expect(messages[0].displayName).toBe('🔧 DevBot');
    });
  });

  describe('getRecentMessages', () => {
    it('should return empty array for unknown channel', () => {
      const messages = manager.getRecentMessages('unknown');
      expect(messages).toEqual([]);
    });

    it('should respect limit parameter', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Message 1');
      manager.recordHumanMessage('channel1', 'Alice', 'Message 2');
      manager.recordHumanMessage('channel1', 'Alice', 'Message 3');

      const messages = manager.getRecentMessages('channel1', 2);
      expect(messages.length).toBe(2);
      expect(messages[0].content).toBe('Message 2');
      expect(messages[1].content).toBe('Message 3');
    });

    it('should trim to max messages', () => {
      // Record 15 messages (max is 10)
      for (let i = 0; i < 15; i++) {
        manager.recordHumanMessage('channel1', 'Alice', `Message ${i}`);
      }

      const messages = manager.getRecentMessages('channel1');
      expect(messages.length).toBe(10);
      expect(messages[0].content).toBe('Message 5'); // First 5 were trimmed
    });
  });

  describe('buildContextForAgent', () => {
    it('should build context excluding own messages', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Fix this bug');
      manager.recordAgentMessage('channel1', mockAgent, 'Here is the fix');
      manager.recordAgentMessage('channel1', mockReviewer, 'Looks good');

      // Developer asking for context should not see own message
      const context = manager.buildContextForAgent('channel1', 'developer', 5);

      expect(context).toContain('Alice');
      expect(context).toContain('Fix this bug');
      expect(context).toContain('Reviewer');
      expect(context).toContain('Looks good');
      expect(context).not.toContain('Here is the fix'); // Developer's own message
    });

    it('should return empty string for empty channel', () => {
      const context = manager.buildContextForAgent('unknown', 'developer', 5);
      expect(context).toBe('');
    });

    it('should truncate long messages', () => {
      const longMessage = 'A'.repeat(2500);
      manager.recordHumanMessage('channel1', 'Alice', longMessage);

      const context = manager.buildContextForAgent('channel1', 'developer', 5);
      expect(context.length).toBeLessThan(2500);
      expect(context).toContain('...');
    });
  });

  describe('getLastAgentMessage', () => {
    it('should return last agent message', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Hello');
      manager.recordAgentMessage('channel1', mockAgent, 'First response');
      manager.recordAgentMessage('channel1', mockReviewer, 'Second response');

      const lastAgent = manager.getLastAgentMessage('channel1');
      expect(lastAgent?.agentId).toBe('reviewer');
      expect(lastAgent?.content).toBe('Second response');
    });

    it('should exclude specified agent', () => {
      manager.recordAgentMessage('channel1', mockAgent, 'First response');
      manager.recordAgentMessage('channel1', mockReviewer, 'Second response');

      const lastAgent = manager.getLastAgentMessage('channel1', 'reviewer');
      expect(lastAgent?.agentId).toBe('developer');
    });

    it('should return null if no agent messages', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Hello');

      const lastAgent = manager.getLastAgentMessage('channel1');
      expect(lastAgent).toBeNull();
    });
  });

  describe('getLastHumanMessage', () => {
    it('should return last human message', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'First message');
      manager.recordAgentMessage('channel1', mockAgent, 'Response');
      manager.recordHumanMessage('channel1', 'Bob', 'Second message');

      const lastHuman = manager.getLastHumanMessage('channel1');
      expect(lastHuman?.displayName).toBe('Bob');
      expect(lastHuman?.content).toBe('Second message');
    });

    it('should return null if no human messages', () => {
      manager.recordAgentMessage('channel1', mockAgent, 'Response');

      const lastHuman = manager.getLastHumanMessage('channel1');
      expect(lastHuman).toBeNull();
    });
  });

  describe('hasAgentRespondedSinceHuman', () => {
    it('should return true if agent responded after last human message', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Question');
      manager.recordAgentMessage('channel1', mockAgent, 'Answer');

      expect(manager.hasAgentRespondedSinceHuman('channel1', 'developer')).toBe(true);
      expect(manager.hasAgentRespondedSinceHuman('channel1', 'reviewer')).toBe(false);
    });

    it('should return false if agent has not responded since last human', () => {
      manager.recordAgentMessage('channel1', mockAgent, 'Old answer');
      manager.recordHumanMessage('channel1', 'Alice', 'New question');

      expect(manager.hasAgentRespondedSinceHuman('channel1', 'developer')).toBe(false);
    });
  });

  describe('channel isolation', () => {
    it('should isolate messages by channel', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Channel 1 message');
      manager.recordHumanMessage('channel2', 'Bob', 'Channel 2 message');

      const channel1Messages = manager.getRecentMessages('channel1');
      const channel2Messages = manager.getRecentMessages('channel2');

      expect(channel1Messages.length).toBe(1);
      expect(channel1Messages[0].displayName).toBe('Alice');

      expect(channel2Messages.length).toBe(1);
      expect(channel2Messages[0].displayName).toBe('Bob');
    });
  });

  describe('clearChannel', () => {
    it('should clear channel context', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Hello');
      manager.recordHumanMessage('channel2', 'Bob', 'Hi');

      manager.clearChannel('channel1');

      expect(manager.getRecentMessages('channel1')).toEqual([]);
      expect(manager.getRecentMessages('channel2').length).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('should clear all contexts', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Hello');
      manager.recordHumanMessage('channel2', 'Bob', 'Hi');

      manager.clearAll();

      expect(manager.getActiveChannels()).toEqual([]);
    });
  });

  describe('getActiveChannels', () => {
    it('should return all channel IDs with active contexts', () => {
      manager.recordHumanMessage('channel1', 'Alice', 'Hello');
      manager.recordHumanMessage('channel2', 'Bob', 'Hi');
      manager.recordHumanMessage('channel3', 'Carol', 'Hey');

      const channels = manager.getActiveChannels();
      expect(channels).toContain('channel1');
      expect(channels).toContain('channel2');
      expect(channels).toContain('channel3');
    });
  });
});
