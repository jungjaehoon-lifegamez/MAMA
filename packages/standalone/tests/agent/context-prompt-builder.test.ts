/**
 * Unit tests for ContextPromptBuilder
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextPrompt,
  buildMinimalContext,
  createAgentContext,
} from '../../src/agent/context-prompt-builder.js';
import type { AgentContext } from '../../src/agent/types.js';
import type { RoleConfig } from '../../src/cli/config/types.js';

describe('ContextPromptBuilder', () => {
  // Helper to create a test context
  const createTestContext = (overrides: Partial<AgentContext> = {}): AgentContext => ({
    source: 'discord',
    platform: 'discord',
    roleName: 'chat_bot',
    role: {
      allowedTools: ['mama_*', 'Read', 'discord_send'],
      blockedTools: ['Bash', 'Write'],
      allowedPaths: ['~/.mama/workspace/**'],
      systemControl: false,
      sensitiveAccess: false,
    },
    session: {
      sessionId: 'test-session-123',
      channelId: '123456789',
      userId: 'user123',
      userName: 'TestUser',
      startedAt: new Date(),
    },
    capabilities: ['mama tools', 'Read', 'discord_send'],
    limitations: ['Cannot use Bash', 'Cannot use Write', 'No system control'],
    ...overrides,
  });

  describe('buildContextPrompt()', () => {
    it('should include header section', () => {
      const context = createTestContext();
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('## Current Agent Context');
      expect(prompt).toContain('### Identity');
    });

    it('should include platform information', () => {
      const context = createTestContext({ platform: 'discord' });
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('**Platform**: Discord');
    });

    it('should include role name and description', () => {
      const context = createTestContext({ roleName: 'chat_bot' });
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('**Role**: chat_bot');
      expect(prompt).toContain('limited permissions');
    });

    it('should include session ID (truncated)', () => {
      const context = createTestContext();
      context.session.sessionId = 'test-session-123456789';
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('**Session**: test-ses...');
    });

    it('should include user name when provided', () => {
      const context = createTestContext();
      context.session.userName = 'JohnDoe';
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('**User**: JohnDoe');
    });

    it('should include channel ID when provided', () => {
      const context = createTestContext();
      context.session.channelId = 'channel-abc123';
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('**Channel**: channel-abc123');
    });

    it('should include capabilities section', () => {
      const context = createTestContext({
        capabilities: ['mama_search', 'Read', 'discord_send'],
      });
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('### Capabilities');
      expect(prompt).toContain('- mama_search');
      expect(prompt).toContain('- Read');
      expect(prompt).toContain('- discord_send');
    });

    it('should include limitations section', () => {
      const context = createTestContext({
        limitations: ['Cannot use Bash', 'No system control'],
      });
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('### Limitations');
      expect(prompt).toContain('- Cannot use Bash');
      expect(prompt).toContain('- No system control');
    });

    it('should include platform-specific guidelines for Discord', () => {
      const context = createTestContext({ platform: 'discord' });
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('### Platform Guidelines');
      expect(prompt).toContain('Discord');
      expect(prompt).toContain('2000 characters');
    });

    it('should include platform-specific guidelines for Telegram', () => {
      const context = createTestContext({ platform: 'telegram' });
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('Telegram');
      expect(prompt).toContain('<b>bold</b>');
    });

    it('should include permission reminders', () => {
      const context = createTestContext();
      context.role.systemControl = false;
      context.role.sensitiveAccess = false;
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('### Permission Reminders');
      expect(prompt).toContain('CANNOT perform system control');
      expect(prompt).toContain('CANNOT access sensitive data');
    });

    it('should indicate allowed permissions for os_agent', () => {
      const context = createTestContext({
        roleName: 'os_agent',
        platform: 'viewer',
        role: {
          allowedTools: ['*'],
          systemControl: true,
          sensitiveAccess: true,
        },
      });
      const prompt = buildContextPrompt(context);

      expect(prompt).toContain('CAN perform system control');
      expect(prompt).toContain('CAN access sensitive data');
    });
  });

  describe('buildMinimalContext()', () => {
    it('should return compact context summary', () => {
      const context = createTestContext({
        platform: 'discord',
        roleName: 'chat_bot',
        capabilities: ['mama_search', 'mama_save', 'Read'],
      });
      const minimal = buildMinimalContext(context);

      expect(minimal).toContain('discord/chat_bot');
      expect(minimal).toContain('mama_search');
    });

    it('should indicate more capabilities when truncated', () => {
      const context = createTestContext({
        capabilities: ['tool1', 'tool2', 'tool3', 'tool4', 'tool5'],
      });
      const minimal = buildMinimalContext(context);

      expect(minimal).toContain('+2 more');
    });

    it('should not show +more for 3 or fewer capabilities', () => {
      const context = createTestContext({
        capabilities: ['tool1', 'tool2', 'tool3'],
      });
      const minimal = buildMinimalContext(context);

      expect(minimal).not.toContain('+');
    });
  });

  describe('createAgentContext()', () => {
    it('should create valid AgentContext', () => {
      const role: RoleConfig = {
        allowedTools: ['mama_*'],
        blockedTools: ['Bash'],
        systemControl: false,
        sensitiveAccess: false,
      };

      const context = createAgentContext(
        'discord',
        'chat_bot',
        role,
        {
          sessionId: 'sess-123',
          channelId: 'ch-456',
          userId: 'user-789',
          userName: 'TestUser',
        },
        ['mama_search', 'mama_save'],
        ['Cannot use Bash']
      );

      expect(context.source).toBe('discord');
      expect(context.platform).toBe('discord');
      expect(context.roleName).toBe('chat_bot');
      expect(context.role).toBe(role);
      expect(context.session.sessionId).toBe('sess-123');
      expect(context.capabilities).toContain('mama_search');
      expect(context.limitations).toContain('Cannot use Bash');
    });

    it('should normalize platform correctly', () => {
      const role: RoleConfig = { allowedTools: ['*'] };

      const viewerContext = createAgentContext(
        'viewer',
        'os_agent',
        role,
        { sessionId: 's1' },
        [],
        []
      );
      expect(viewerContext.platform).toBe('viewer');

      const discordContext = createAgentContext(
        'discord',
        'chat_bot',
        role,
        { sessionId: 's2' },
        [],
        []
      );
      expect(discordContext.platform).toBe('discord');

      const unknownContext = createAgentContext(
        'unknown',
        'custom',
        role,
        { sessionId: 's3' },
        [],
        []
      );
      expect(unknownContext.platform).toBe('cli'); // Default for unknown
    });

    it('should set startedAt timestamp', () => {
      const role: RoleConfig = { allowedTools: ['*'] };
      const before = new Date();

      const context = createAgentContext('discord', 'bot', role, { sessionId: 's1' }, [], []);

      const after = new Date();
      expect(context.session.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(context.session.startedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('platform guidelines', () => {
    it('should have guidelines for all platforms', () => {
      const platforms: Array<AgentContext['platform']> = [
        'viewer',
        'discord',
        'telegram',
        'slack',
        'chatwork',
        'cli',
      ];

      for (const platform of platforms) {
        const context = createTestContext({ platform });
        const prompt = buildContextPrompt(context);
        expect(prompt).toContain('### Platform Guidelines');
      }
    });
  });
});
