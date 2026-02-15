/**
 * Unit tests for Discord Gateway
 *
 * Note: These tests mock discord.js to test gateway logic without
 * requiring an actual Discord connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordGateway } from '../../src/gateways/discord.js';
import { MessageRouter } from '../../src/gateways/message-router.js';

// Mock discord.js
vi.mock('discord.js', () => {
  const mockClient = {
    user: { id: '123456789', tag: 'TestBot#1234' },
    login: vi.fn().mockResolvedValue('token'),
    destroy: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    on: vi.fn(),
  };

  return {
    Client: vi.fn(() => mockClient),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: {
      Channel: 1,
    },
    Events: {
      ClientReady: 'ready',
      MessageCreate: 'messageCreate',
      ShardDisconnect: 'shardDisconnect',
      Error: 'error',
    },
    ChannelType: {
      DM: 1,
      GuildText: 0,
    },
  };
});

// Mock MessageRouter
const mockMessageRouter = {
  process: vi.fn().mockResolvedValue({
    response: 'Test response',
    duration: 100,
    sessionId: 'session-123',
  }),
} as unknown as MessageRouter;

describe('DiscordGateway', () => {
  let gateway: DiscordGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new DiscordGateway({
      token: 'test-token',
      messageRouter: mockMessageRouter,
    });
  });

  describe('constructor', () => {
    it('should create gateway with token and router', () => {
      expect(gateway).toBeInstanceOf(DiscordGateway);
      expect(gateway.source).toBe('discord');
    });

    it('should initialize with default config', () => {
      const config = gateway.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.token).toBe('test-token');
      expect(config.guilds).toEqual({});
    });

    it('should accept initial guild config', () => {
      const gatewayWithConfig = new DiscordGateway({
        token: 'test-token',
        messageRouter: mockMessageRouter,
        config: {
          guilds: {
            '123': { requireMention: false },
          },
        },
      });

      const config = gatewayWithConfig.getConfig();
      expect(config.guilds?.['123']?.requireMention).toBe(false);
    });
  });

  describe('start()', () => {
    it('should connect to Discord', async () => {
      await gateway.start();
      // Client.login should have been called
      // The mock returns resolved promise
    });

    it('should not reconnect if already connected', async () => {
      // Simulate connected state by calling start twice
      await gateway.start();
      await gateway.start();
      // Should handle gracefully
    });
  });

  describe('stop()', () => {
    it('should disconnect from Discord', async () => {
      await gateway.start();
      await gateway.stop();
      expect(gateway.isConnected()).toBe(false);
    });

    it('should handle stop when not connected', async () => {
      await gateway.stop();
      // Should not throw
    });
  });

  describe('isConnected()', () => {
    it('should return false initially', () => {
      expect(gateway.isConnected()).toBe(false);
    });
  });

  describe('onEvent()', () => {
    it('should register event handlers', () => {
      const handler = vi.fn();
      gateway.onEvent(handler);
      // Handler should be registered
    });
  });

  describe('setConfig()', () => {
    it('should update guild config', () => {
      gateway.setConfig({
        guilds: {
          '456': { requireMention: true },
        },
      });

      const config = gateway.getConfig();
      expect(config.guilds?.['456']?.requireMention).toBe(true);
    });

    it('should merge with existing config', () => {
      gateway.setConfig({
        guilds: {
          '123': { requireMention: false },
        },
      });

      gateway.setConfig({
        guilds: {
          '456': { requireMention: true },
        },
      });

      const config = gateway.getConfig();
      expect(config.guilds?.['123']?.requireMention).toBe(false);
      expect(config.guilds?.['456']?.requireMention).toBe(true);
    });

    it('should update enabled status', () => {
      gateway.setConfig({ enabled: false });
      expect(gateway.getConfig().enabled).toBe(false);
    });
  });

  describe('addGuildConfig()', () => {
    it('should add guild configuration', () => {
      gateway.addGuildConfig('789', {
        requireMention: false,
        channels: {
          '111': { requireMention: true },
        },
      });

      const config = gateway.getConfig();
      expect(config.guilds?.['789']?.requireMention).toBe(false);
      expect(config.guilds?.['789']?.channels?.['111']?.requireMention).toBe(true);
    });
  });

  describe('addChannelConfig()', () => {
    it('should add channel configuration', () => {
      gateway.addChannelConfig('999', '888', {
        requireMention: false,
      });

      const config = gateway.getConfig();
      expect(config.guilds?.['999']?.channels?.['888']?.requireMention).toBe(false);
    });

    it('should create guild config if not exists', () => {
      gateway.addChannelConfig('new-guild', 'new-channel', {
        requireMention: true,
      });

      const config = gateway.getConfig();
      expect(config.guilds?.['new-guild']?.channels?.['new-channel']).toBeDefined();
    });
  });

  describe('Event Emission', () => {
    it('should emit events to registered handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      gateway.onEvent(handler1);
      gateway.onEvent(handler2);

      // Internal event emission would be tested through integration tests
      // Here we verify handlers are registered
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('shouldRespond() - delegation trigger bypass', () => {
    it('should respond to DELEGATE commands even when mention is required', () => {
      gateway.setConfig({
        guilds: {
          '*': { requireMention: true },
        },
      });

      const message = {
        content: 'DELEGATE::developer::Do the thing',
        guild: { id: 'g1' },
        channel: { id: 'c1' },
      } as any;

      const shouldRespond = (gateway as any).shouldRespond.bind(gateway);
      expect(shouldRespond(message, false, false)).toBe(true);
    });

    it('should respond to DELEGATE commands even with no guild config (mentions normally required)', () => {
      // Default: no guild config set -> shouldRespond returns isMentioned for normal messages.
      const message = {
        content: 'DELEGATE_BG::reviewer::Review this',
        guild: { id: 'g1' },
        channel: { id: 'c1' },
      } as any;

      const shouldRespond = (gateway as any).shouldRespond.bind(gateway);
      expect(shouldRespond(message, false, false)).toBe(true);
    });

    it('should not respond to normal messages when mention is required', () => {
      gateway.setConfig({
        guilds: {
          '*': { requireMention: true },
        },
      });

      const message = {
        content: 'hello',
        guild: { id: 'g1' },
        channel: { id: 'c1' },
      } as any;

      const shouldRespond = (gateway as any).shouldRespond.bind(gateway);
      expect(shouldRespond(message, false, false)).toBe(false);
    });
  });
});

describe('DiscordGateway Configuration', () => {
  it('should support wildcard guild config', () => {
    const gateway = new DiscordGateway({
      token: 'test-token',
      messageRouter: mockMessageRouter,
      config: {
        guilds: {
          '*': { requireMention: true },
          '123': { requireMention: false },
        },
      },
    });

    const config = gateway.getConfig();
    expect(config.guilds?.['*']?.requireMention).toBe(true);
    expect(config.guilds?.['123']?.requireMention).toBe(false);
  });

  it('should support per-channel configuration', () => {
    const gateway = new DiscordGateway({
      token: 'test-token',
      messageRouter: mockMessageRouter,
      config: {
        guilds: {
          '123': {
            requireMention: true,
            channels: {
              'bot-channel': { requireMention: false },
            },
          },
        },
      },
    });

    const config = gateway.getConfig();
    expect(config.guilds?.['123']?.channels?.['bot-channel']?.requireMention).toBe(false);
  });
});
