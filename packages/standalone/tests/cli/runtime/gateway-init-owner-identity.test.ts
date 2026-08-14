import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';

const gatewayMocks = vi.hoisted(() => ({
  discordOptions: vi.fn(),
  slackOptions: vi.fn(),
  telegramOptions: vi.fn(),
  setTelegramTrust: vi.fn(),
}));

vi.mock('../../../src/gateways/index.js', () => {
  class GatewayDouble {
    constructor(options: unknown) {
      void options;
    }

    async start(): Promise<void> {}

    async stop(): Promise<void> {}

    async sendMessage(): Promise<void> {}

    async sendFile(): Promise<void> {}

    async sendImage(): Promise<void> {}

    async sendSticker(): Promise<void> {}
  }

  return {
    DiscordGateway: class extends GatewayDouble {
      constructor(options: unknown) {
        super(options);
        gatewayMocks.discordOptions(options);
      }
    },
    SlackGateway: class extends GatewayDouble {
      constructor(options: unknown) {
        super(options);
        gatewayMocks.slackOptions(options);
      }
    },
    TelegramGateway: class extends GatewayDouble {
      constructor(options: unknown) {
        super(options);
        gatewayMocks.telegramOptions(options);
      }
    },
    MessageRouter: class {},
  };
});

vi.mock('../../../src/agent/role-manager.js', () => ({
  getRoleManager: vi.fn(() => ({
    setTelegramTrust: gatewayMocks.setTelegramTrust,
  })),
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
  },
}));

import { initGateways } from '../../../src/cli/runtime/gateway-init.js';

describe('Gateway owner identity initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes CLI owner identity fields to each local gateway constructor', async () => {
    const config = {
      discord: {
        enabled: true,
        token: 'discord-token-synthetic',
        owner_user_id: 'discord-owner-1',
      },
      slack: {
        enabled: true,
        bot_token: 'slack-bot-token-synthetic',
        app_token: 'slack-app-token-synthetic',
        owner_user_id: 'slack-owner-1',
      },
      telegram: {
        enabled: true,
        token: 'telegram-token-synthetic',
        allowed_chats: ['telegram-chat-1'],
        owner_user_ids: ['telegram-owner-1', 'telegram-owner-2'],
      },
    } as unknown as MAMAConfig;
    const toolExecutor = {
      setSlackGateway: vi.fn(),
      setTelegramGateway: vi.fn(),
    };
    const agentLoop = {
      setDiscordGateway: vi.fn(),
      setTelegramGateway: vi.fn(),
    };

    await initGateways(
      config,
      {} as never,
      toolExecutor as never,
      agentLoop as never,
      'codex',
      {} as never
    );

    expect(gatewayMocks.discordOptions).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'discord-owner-1' })
    );
    expect(gatewayMocks.slackOptions).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'slack-owner-1' })
    );
    expect(gatewayMocks.telegramOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          ownerUserIds: ['telegram-owner-1', 'telegram-owner-2'],
        }),
      })
    );
  });
});
