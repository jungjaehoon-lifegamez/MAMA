import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';

const seams = vi.hoisted(() => ({
  createPrincipalRepository: vi.fn(),
  discordOptions: vi.fn(),
  slackOptions: vi.fn(),
  telegramOptions: vi.fn(),
  starts: vi.fn(),
}));

vi.mock('@jungjaehoon/mama-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jungjaehoon/mama-core')>()),
  createPrincipalRepository: seams.createPrincipalRepository,
}));

vi.mock('../../../src/gateways/index.js', () => {
  class GatewayDouble {
    constructor(options: unknown) {
      void options;
    }

    async start(): Promise<void> {
      seams.starts();
    }

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
        seams.discordOptions(options);
      }
    },
    SlackGateway: class extends GatewayDouble {
      constructor(options: unknown) {
        super(options);
        seams.slackOptions(options);
      }
    },
    TelegramGateway: class extends GatewayDouble {
      constructor(options: unknown) {
        super(options);
        seams.telegramOptions(options);
      }
    },
    MessageRouter: class {},
    SessionStore: class {},
    initChannelHistory: vi.fn(),
  };
});

vi.mock('../../../src/agent/role-manager.js', () => ({
  getRoleManager: vi.fn(() => ({ setTelegramTrust: vi.fn() })),
  RoleManager: class {},
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: class {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
  },
}));

import { createCorePrincipalResolver } from '../../../src/cli/commands/start.js';
import { initGateways } from '../../../src/cli/runtime/gateway-init.js';

describe('Principal registry startup wiring', () => {
  const config = {
    discord: { enabled: true, token: 'discord-token-synthetic' },
    slack: {
      enabled: true,
      bot_token: 'slack-bot-token-synthetic',
      app_token: 'slack-app-token-synthetic',
    },
    telegram: { enabled: true, token: 'telegram-token-synthetic' },
  } as unknown as MAMAConfig;
  const toolExecutor = {
    setSlackGateway: vi.fn(),
    setTelegramGateway: vi.fn(),
  };
  const agentLoop = {
    setDiscordGateway: vi.fn(),
    setTelegramGateway: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs one resolver from the core adapter and injects it into every gateway', async () => {
    const coreAdapter = { marker: 'core-adapter' };
    const resolveByExternal = vi.fn(() => null);
    seams.createPrincipalRepository.mockReturnValue({ resolveByExternal });

    const principalResolver = createCorePrincipalResolver(coreAdapter as never);

    expect(seams.createPrincipalRepository).toHaveBeenCalledOnce();
    expect(seams.createPrincipalRepository).toHaveBeenCalledWith(coreAdapter);
    expect(principalResolver('telegram', 'private', 'missing-member')).toBeNull();

    await initGateways(
      config,
      {} as never,
      toolExecutor as never,
      agentLoop as never,
      'codex',
      {} as never,
      principalResolver
    );

    expect(seams.discordOptions).toHaveBeenCalledWith(
      expect.objectContaining({ principalResolver })
    );
    expect(seams.slackOptions).toHaveBeenCalledWith(expect.objectContaining({ principalResolver }));
    expect(seams.telegramOptions).toHaveBeenCalledWith(
      expect.objectContaining({ principalResolver })
    );
    expect(resolveByExternal).toHaveBeenCalledOnce();
    expect(seams.starts).toHaveBeenCalledTimes(3);
  });

  it('keeps Phase 1 gateway initialization unchanged when no resolver is provided', async () => {
    await initGateways(
      config,
      {} as never,
      toolExecutor as never,
      agentLoop as never,
      'codex',
      {} as never
    );

    expect(seams.discordOptions).toHaveBeenCalledWith(
      expect.objectContaining({ principalResolver: undefined })
    );
    expect(seams.slackOptions).toHaveBeenCalledWith(
      expect.objectContaining({ principalResolver: undefined })
    );
    expect(seams.telegramOptions).toHaveBeenCalledWith(
      expect.objectContaining({ principalResolver: undefined })
    );
    expect(seams.starts).toHaveBeenCalledTimes(3);
  });
});
