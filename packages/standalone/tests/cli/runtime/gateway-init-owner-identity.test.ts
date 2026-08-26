import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';

const gatewayMocks = vi.hoisted(() => ({
  discordOptions: vi.fn(),
  slackOptions: vi.fn(),
  telegramOptions: vi.fn(),
  setTelegramTrust: vi.fn(),
  telegramSendMessage: vi.fn().mockResolvedValue(undefined),
  telegramSendFile: vi.fn().mockResolvedValue(undefined),
  telegramSendImage: vi.fn().mockResolvedValue(undefined),
  telegramSendSticker: vi.fn().mockResolvedValue(true),
  telegramSendMessageFromActiveTurn: vi.fn().mockResolvedValue(undefined),
  telegramSendFileFromActiveTurn: vi.fn().mockResolvedValue(undefined),
  telegramSendImageFromActiveTurn: vi.fn().mockResolvedValue(undefined),
  telegramSendStickerFromActiveTurn: vi.fn().mockResolvedValue(true),
  telegramReadReceipt: vi.fn().mockReturnValue({
    deliveryId: 'delivery-1',
    variant: 'text',
    state: 'delivered',
    payloadIdentity: 'a'.repeat(64),
    confirmedAt: 1_000,
  }),
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

      override async sendMessage(...args: unknown[]): Promise<void> {
        await gatewayMocks.telegramSendMessage(...args);
      }

      override async sendFile(...args: unknown[]): Promise<void> {
        await gatewayMocks.telegramSendFile(...args);
      }

      override async sendImage(...args: unknown[]): Promise<void> {
        await gatewayMocks.telegramSendImage(...args);
      }

      override async sendSticker(...args: unknown[]): Promise<void> {
        await gatewayMocks.telegramSendSticker(...args);
      }

      async sendMessageFromActiveTurn(...args: unknown[]): Promise<void> {
        await gatewayMocks.telegramSendMessageFromActiveTurn(...args);
      }

      async sendFileFromActiveTurn(...args: unknown[]): Promise<void> {
        await gatewayMocks.telegramSendFileFromActiveTurn(...args);
      }

      async sendImageFromActiveTurn(...args: unknown[]): Promise<void> {
        await gatewayMocks.telegramSendImageFromActiveTurn(...args);
      }

      async sendStickerFromActiveTurn(...args: unknown[]): Promise<boolean> {
        return gatewayMocks.telegramSendStickerFromActiveTurn(...args) as Promise<boolean>;
      }

      readOutboundDeliveryReceipt(...args: unknown[]): unknown {
        return gatewayMocks.telegramReadReceipt(...args);
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

  it('TG-01/TG-06 preserves Telegram delivery identity and active-turn capabilities', async () => {
    const config = {
      telegram: {
        enabled: true,
        token: 'telegram-token-synthetic',
        allowed_chats: ['telegram-chat-1'],
      },
    } as unknown as MAMAConfig;
    const toolExecutor = { setTelegramGateway: vi.fn() };
    const agentLoop = { setTelegramGateway: vi.fn() };

    await initGateways(
      config,
      {} as never,
      toolExecutor as never,
      agentLoop as never,
      'codex',
      {} as never
    );

    const adapter = toolExecutor.setTelegramGateway.mock.calls[0]?.[0] as {
      sendMessage(chatId: string, text: string, deliveryId?: string): Promise<void>;
      sendFile(chatId: string, path: string, caption?: string, deliveryId?: string): Promise<void>;
      sendImage(chatId: string, path: string, caption?: string, deliveryId?: string): Promise<void>;
      sendSticker(chatId: string, emotion: string, deliveryId?: string): Promise<boolean>;
      sendMessageFromActiveTurn(chatId: string, text: string, deliveryId?: string): Promise<void>;
      readOutboundDeliveryReceipt(deliveryId: string, variant: string): unknown;
    };
    expect(agentLoop.setTelegramGateway).toHaveBeenCalledWith(adapter);

    await adapter.sendMessage('7777', 'body', 'delivery-text');
    await adapter.sendFile('7777', '/private/file', 'caption', 'delivery-file');
    await adapter.sendImage('7777', '/private/image', 'caption', 'delivery-image');
    await adapter.sendSticker('7777', 'happy', 'delivery-sticker');
    await adapter.sendMessageFromActiveTurn('7777', 'active body', 'delivery-active');
    const receipt = adapter.readOutboundDeliveryReceipt('delivery-1', 'text');

    expect(gatewayMocks.telegramSendMessage).toHaveBeenCalledWith('7777', 'body', 'delivery-text');
    expect(gatewayMocks.telegramSendFile).toHaveBeenCalledWith(
      '7777',
      '/private/file',
      'caption',
      'delivery-file'
    );
    expect(gatewayMocks.telegramSendImage).toHaveBeenCalledWith(
      '7777',
      '/private/image',
      'caption',
      'delivery-image'
    );
    expect(gatewayMocks.telegramSendSticker).toHaveBeenCalledWith(
      '7777',
      'happy',
      'delivery-sticker'
    );
    expect(gatewayMocks.telegramSendMessageFromActiveTurn).toHaveBeenCalledWith(
      '7777',
      'active body',
      'delivery-active'
    );
    expect(gatewayMocks.telegramReadReceipt).toHaveBeenCalledWith('delivery-1', 'text');
    expect(receipt).toMatchObject({ state: 'delivered', variant: 'text' });
  });
});
