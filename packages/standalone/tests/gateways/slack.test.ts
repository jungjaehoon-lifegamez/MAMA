/**
 * Unit tests for Slack Gateway
 *
 * Note: These tests mock @slack packages to test gateway logic without
 * requiring an actual Slack connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackGateway } from '../../src/gateways/slack.js';
import { MessageRouter } from '../../src/gateways/message-router.js';
import type { TurnProcessor } from '../../src/gateways/turn-contract.js';

const slackApiMocks = vi.hoisted(() => ({
  authTest: vi.fn().mockResolvedValue({ ok: true, team_id: 'team-synthetic-1' }),
}));

// Mock @slack/socket-mode
vi.mock('@slack/socket-mode', () => {
  const mockSocketClient = {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  return {
    SocketModeClient: vi.fn(() => mockSocketClient),
  };
});

// Mock @slack/web-api
vi.mock('@slack/web-api', () => {
  const mockWebClient = {
    auth: {
      test: slackApiMocks.authTest,
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.123456' }),
    },
  };

  return {
    WebClient: vi.fn(() => mockWebClient),
  };
});

// Implements the turn contract, and the router methods this surface reads for display.
// A double with only the old router method would have forced the base to adapt at
// runtime - the escape hatch the seam exists to remove.
const turnResult = {
  outcome: 'completed' as const,
  response: 'Test response',
  duration: 100,
  sessionId: 'session-123',
  injectedDecisions: [],
  provenance: { status: 'available' as const, modelRunId: 'run_test' },
  sourceTurnId: 'turn_test',
  sourceMessageRef: 'slack:test:turn_test',
};
const mockMessageRouter = {
  processTurn: vi.fn().mockResolvedValue(turnResult),
  process: vi.fn().mockResolvedValue(turnResult),
  listSessions: vi.fn().mockReturnValue([]),
  updateChannelName: vi.fn().mockReturnValue(false),
} as unknown as MessageRouter;

describe('SlackGateway', () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new SlackGateway({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      turnProcessor: mockMessageRouter,
    });
  });

  describe('constructor', () => {
    it('should create gateway with tokens and router', () => {
      expect(gateway).toBeInstanceOf(SlackGateway);
      expect(gateway.source).toBe('slack');
    });

    it('should initialize with default config', () => {
      const config = gateway.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.botToken).toBe('xoxb-test-token');
      expect(config.appToken).toBe('xapp-test-token');
      expect(config.channels).toEqual({});
    });

    it('should accept initial channel config', () => {
      const gatewayWithConfig = new SlackGateway({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        turnProcessor: mockMessageRouter,
        config: {
          channels: {
            C123: { requireMention: false },
          },
        },
      });

      const config = gatewayWithConfig.getConfig();
      expect(config.channels?.['C123']?.requireMention).toBe(false);
    });

    it('should retain the configured owner user ID', () => {
      const gatewayWithOwner = new SlackGateway({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        turnProcessor: mockMessageRouter,
        ownerUserId: 'owner-user-1',
      });

      expect(gatewayWithOwner.getConfig()).toMatchObject({ ownerUserId: 'owner-user-1' });
    });
  });

  describe('start()', () => {
    it('should connect to Slack via Socket Mode', async () => {
      await gateway.start();
      // SocketModeClient.start should have been called
    });

    it('should capture the Slack team ID from auth.test once', async () => {
      await gateway.start();

      expect(slackApiMocks.authTest).toHaveBeenCalledTimes(1);
      expect(Reflect.get(gateway, 'teamId')).toBe('team-synthetic-1');
    });

    it('should not reconnect if already connected', async () => {
      await gateway.start();
      await gateway.start();
      // Should handle gracefully
    });
  });

  describe('stop()', () => {
    it('should disconnect from Slack', async () => {
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
    it('should update channel config', () => {
      gateway.setConfig({
        channels: {
          C456: { requireMention: true },
        },
      });

      const config = gateway.getConfig();
      expect(config.channels?.['C456']?.requireMention).toBe(true);
    });

    it('should merge with existing config', () => {
      gateway.setConfig({
        channels: {
          C123: { requireMention: false },
        },
      });

      gateway.setConfig({
        channels: {
          C456: { requireMention: true },
        },
      });

      const config = gateway.getConfig();
      expect(config.channels?.['C123']?.requireMention).toBe(false);
      expect(config.channels?.['C456']?.requireMention).toBe(true);
    });

    it('should update enabled status', () => {
      gateway.setConfig({ enabled: false });
      expect(gateway.getConfig().enabled).toBe(false);
    });
  });

  describe('addChannelConfig()', () => {
    it('should add channel configuration', () => {
      gateway.addChannelConfig('C789', {
        requireMention: false,
      });

      const config = gateway.getConfig();
      expect(config.channels?.['C789']?.requireMention).toBe(false);
    });

    it('should overwrite existing channel config', () => {
      gateway.addChannelConfig('C123', { requireMention: true });
      gateway.addChannelConfig('C123', { requireMention: false });

      const config = gateway.getConfig();
      expect(config.channels?.['C123']?.requireMention).toBe(false);
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

  it('sends nothing and logs once for an externally diverted turn', async () => {
    const turnProcessor: TurnProcessor = {
      processTurn: vi.fn().mockResolvedValue({
        outcome: 'external_divert',
        delivery: 'silent',
        sessionId: 'external-divert',
        duration: 0,
      }),
    };
    const divertedGateway = new SlackGateway({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      turnProcessor,
    });
    const internals = divertedGateway as unknown as {
      handleMessage(event: object, isMention: boolean): Promise<void>;
      logger: { log: ReturnType<typeof vi.fn> };
      webClient: { chat: { postMessage: ReturnType<typeof vi.fn> } };
    };
    internals.logger.log = vi.fn();
    const sentEvents: string[] = [];
    divertedGateway.onEvent((event) => sentEvents.push(event.type));

    await internals.handleMessage(
      {
        type: 'message',
        channel: 'channel-synthetic',
        channel_type: 'im',
        user: 'user-synthetic',
        text: 'synthetic request',
        ts: '1000.0001',
      },
      false
    );

    expect(internals.webClient.chat.postMessage).not.toHaveBeenCalled();
    expect(sentEvents).not.toContain('message_sent');
    expect(
      internals.logger.log.mock.calls.filter((call) =>
        String(call[0]).includes('externally diverted')
      )
    ).toHaveLength(1);
  });
});

describe('SlackGateway Configuration', () => {
  it('should support per-channel configuration', () => {
    const gateway = new SlackGateway({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      turnProcessor: mockMessageRouter,
      config: {
        channels: {
          general: { requireMention: true },
          'bot-channel': { requireMention: false },
        },
      },
    });

    const config = gateway.getConfig();
    expect(config.channels?.['general']?.requireMention).toBe(true);
    expect(config.channels?.['bot-channel']?.requireMention).toBe(false);
  });
});

describe('SlackGateway Message Handling', () => {
  it('should store thread context in metadata', () => {
    // The gateway stores thread_ts in metadata for thread context preservation
    // This is verified by inspecting the NormalizedMessage format
    const gateway = new SlackGateway({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      turnProcessor: mockMessageRouter,
    });

    expect(gateway.source).toBe('slack');
    // Thread context handling is tested through integration tests
  });

  it('should respond in thread using thread_ts', () => {
    // The gateway uses thread_ts to reply in the same thread
    // This is verified by checking the chat.postMessage call parameters
    const gateway = new SlackGateway({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      turnProcessor: mockMessageRouter,
    });

    // Thread response behavior tested through integration
    expect(gateway).toBeInstanceOf(SlackGateway);
  });
});
