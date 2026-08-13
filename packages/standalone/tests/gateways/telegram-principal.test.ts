import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue({ file_path: 'photo.jpg', file_size: 4 }),
    getStickerSet: vi.fn().mockResolvedValue({ stickers: [] }),
  },
  handlers: new Map<string, (ctx: unknown) => Promise<void> | void>(),
  downloadTelegramMedia: vi.fn(),
  logSecurityEventOnly: vi.fn(),
}));

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void> | void) => {
      seams.handlers.set(event, handler);
    }),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 123, username: 'test_bot' },
    api: seams.api,
  })),
}));

vi.mock('../../src/memory/memory-logger.js', () => ({
  getMemoryLogger: vi.fn(() => ({ logMessage: vi.fn() })),
}));

vi.mock('../../src/gateways/telegram-media.js', () => ({
  downloadTelegramMedia: seams.downloadTelegramMedia,
  pruneTelegramMediaRoot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/security/security-monitor.js', () => ({
  logSecurityEventOnly: seams.logSecurityEventOnly,
}));

import { TelegramGateway } from '../../src/gateways/telegram.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import { TelegramResponsePresenter } from '../../src/gateways/telegram-response-presenter.js';
import type { TurnProcessor } from '../../src/gateways/turn-contract.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

interface SyntheticTelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup'; title?: string };
  from: { id: number; is_bot: false; first_name: string; username: string };
  text?: string;
  entities?: Array<{ type: 'mention' | 'bot_command'; offset: number; length: number }>;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
}

function makeMessage(input: {
  chatId: number;
  userId: number;
  messageId: number;
  chatType?: 'private' | 'group' | 'supergroup';
  text?: string;
  entities?: SyntheticTelegramMessage['entities'];
  photo?: SyntheticTelegramMessage['photo'];
}): SyntheticTelegramMessage {
  return {
    message_id: input.messageId,
    date: 1_700_000_000,
    chat: {
      id: input.chatId,
      type: input.chatType ?? 'private',
      title: input.chatType === 'private' || input.chatType === undefined ? undefined : 'Synthetic',
    },
    from: {
      id: input.userId,
      is_bot: false,
      first_name: 'Synthetic',
      username: `synthetic-${input.userId}`,
    },
    text: input.text,
    entities: input.entities,
    photo: input.photo,
  };
}

function completed(response = 'completed'): ReturnType<TurnProcessor['processTurn']> {
  return Promise.resolve({
    outcome: 'completed',
    response,
    sessionId: 'synthetic-session',
    injectedDecisions: [],
    duration: 1,
    provenance: { status: 'available', modelRunId: 'synthetic-run' },
    sourceTurnId: 'synthetic-turn',
    sourceMessageRef: 'telegram:synthetic:turn',
  });
}

async function makeGateway(input: {
  turnProcessor: TurnProcessor;
  allowedChats: string[];
  ownerUserIds?: string[];
}): Promise<TelegramGateway> {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'mama-telegram-principal-'));
  const gateway = new TelegramGateway({
    token: 'synthetic-token',
    turnProcessor: input.turnProcessor,
    config: {
      allowedChats: input.allowedChats,
      ownerUserIds: input.ownerUserIds,
    },
    mediaRoot,
    messageLedgerPath: join(mediaRoot, 'ledger.json'),
    fetchImpl: vi.fn(),
  });
  await gateway.start();
  return gateway;
}

async function deliver(message: SyntheticTelegramMessage): Promise<void> {
  const handler = seams.handlers.get('message');
  expect(handler).toBeTypeOf('function');
  await handler!({ message });
}

describe('Story TG-01/TG-04: Telegram ingress principal admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seams.handlers.clear();
    seams.api.sendMessage.mockResolvedValue({ message_id: 1 });
  });

  it('diverts an unresolved external principal before presenter, typing, ledger, download, or send', async () => {
    const turnProcessor: TurnProcessor = { processTurn: vi.fn(() => completed()) };
    const presenterStart = vi.spyOn(TelegramResponsePresenter.prototype, 'start');
    const ledgerClaim = vi.spyOn(TelegramMessageLedger.prototype, 'claim');
    const gateway = await makeGateway({
      turnProcessor,
      allowedChats: ['7001'],
      ownerUserIds: [],
    });
    presenterStart.mockClear();
    ledgerClaim.mockClear();

    await deliver(
      makeMessage({
        chatId: 7001,
        userId: 7001,
        messageId: 1,
        text: 'inspect this',
        photo: [
          {
            file_id: 'synthetic-photo',
            file_unique_id: 'synthetic-photo-unique',
            width: 10,
            height: 10,
            file_size: 4,
          },
        ],
      })
    );

    expect(seams.logSecurityEventOnly).toHaveBeenCalledTimes(1);
    expect(turnProcessor.processTurn).not.toHaveBeenCalled();
    expect(presenterStart).not.toHaveBeenCalled();
    expect(seams.api.sendChatAction).not.toHaveBeenCalled();
    expect(ledgerClaim).not.toHaveBeenCalled();
    expect(seams.downloadTelegramMedia).not.toHaveBeenCalled();
    expect(seams.api.getFile).not.toHaveBeenCalled();
    expect(seams.api.sendMessage).not.toHaveBeenCalled();
    expect(seams.api.editMessageText).not.toHaveBeenCalled();
    expect(seams.api.deleteMessage).not.toHaveBeenCalled();
    expect(seams.api.sendPhoto).not.toHaveBeenCalled();
    expect(seams.api.sendDocument).not.toHaveBeenCalled();
    expect(seams.api.sendSticker).not.toHaveBeenCalled();
    await gateway.stop();
    presenterStart.mockRestore();
    ledgerClaim.mockRestore();
  });

  it('admits a mentioned group non-owner to the public lane while still ignoring unmentioned text', async () => {
    const routed: NormalizedMessage[] = [];
    const turnProcessor: TurnProcessor = {
      processTurn: vi.fn((message) => {
        routed.push(message);
        return completed();
      }),
    };
    const gateway = await makeGateway({
      turnProcessor,
      allowedChats: ['-7002'],
      ownerUserIds: ['9001'],
    });

    await deliver(
      makeMessage({
        chatId: -7002,
        userId: 7002,
        messageId: 2,
        chatType: 'supergroup',
        text: 'unmentioned',
      })
    );
    expect(turnProcessor.processTurn).not.toHaveBeenCalled();

    await deliver(
      makeMessage({
        chatId: -7002,
        userId: 7002,
        messageId: 3,
        chatType: 'supergroup',
        text: '@test_bot status',
        entities: [{ type: 'mention', offset: 0, length: 9 }],
      })
    );

    expect(turnProcessor.processTurn).toHaveBeenCalledTimes(1);
    expect(routed[0]?.text).toBe('status');
    expect(routed[0]?.principal).toEqual({
      class: 'external',
      lane: 'public',
      canonicalId: 'telegram:global:7002',
      consoleEligible: false,
    });
    expect(Object.isFrozen(routed[0]?.principal)).toBe(true);
    await gateway.stop();
  });

  it('keeps the full owner private-chat flow and attaches a console-eligible owner principal', async () => {
    const routed: NormalizedMessage[] = [];
    const turnProcessor: TurnProcessor = {
      processTurn: vi.fn((message) => {
        routed.push(message);
        return completed('owner response');
      }),
    };
    const gateway = await makeGateway({
      turnProcessor,
      allowedChats: ['7003'],
      ownerUserIds: ['7003'],
    });

    await deliver(makeMessage({ chatId: 7003, userId: 7003, messageId: 4, text: 'owner request' }));

    expect(turnProcessor.processTurn).toHaveBeenCalledTimes(1);
    expect(routed[0]?.principal).toEqual({
      class: 'owner',
      lane: 'owner',
      canonicalId: 'telegram:global:7003',
      consoleEligible: true,
    });
    expect(Object.isFrozen(routed[0]?.principal)).toBe(true);
    expect(seams.api.sendMessage).toHaveBeenCalledWith(7003, '⏳');
    expect(seams.api.sendChatAction).toHaveBeenCalledWith(7003, 'typing');
    expect(seams.api.editMessageText).toHaveBeenCalledWith(7003, 1, 'owner response');
    await gateway.stop();
  });

  it('routes an allowlisted third-party positive-ID DM to public when owners are explicit', async () => {
    const routed: NormalizedMessage[] = [];
    const turnProcessor: TurnProcessor = {
      processTurn: vi.fn((message) => {
        routed.push(message);
        return completed();
      }),
    };
    const gateway = await makeGateway({
      turnProcessor,
      allowedChats: ['7004'],
      ownerUserIds: ['9001'],
    });

    await deliver(
      makeMessage({ chatId: 7004, userId: 7004, messageId: 5, text: 'public request' })
    );

    expect(turnProcessor.processTurn).toHaveBeenCalledTimes(1);
    expect(routed[0]?.principal).toMatchObject({
      class: 'external',
      lane: 'public',
      consoleEligible: false,
    });
    await gateway.stop();
  });
});

describe('public lane media containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seams.handlers.clear();
    seams.api.sendMessage.mockResolvedValue({ message_id: 1 });
  });

  it('never downloads a non-owner group photo and passes text without content blocks', async () => {
    const processTurn = vi.fn(() => completed());
    const turnProcessor: TurnProcessor = { processTurn };
    const gateway = await makeGateway({
      turnProcessor,
      allowedChats: ['1001', '-2002'],
      ownerUserIds: ['1001'],
    });
    void gateway;

    await deliver(
      makeMessage({
        chatId: -2002,
        userId: 9999,
        messageId: 9101,
        chatType: 'group',
        text: '@test_bot please look at this',
        entities: [{ type: 'mention', offset: 0, length: '@test_bot'.length }],
        photo: [{ file_id: 'f1', file_unique_id: 'u1', file_size: 1234, width: 10, height: 10 }],
      })
    );

    expect(seams.api.getFile).not.toHaveBeenCalled();
    expect(processTurn).toHaveBeenCalledTimes(1);
    const passed = processTurn.mock.calls[0][0] as NormalizedMessage;
    expect(passed.principal?.lane).toBe('public');
    expect(passed.contentBlocks).toBeUndefined();
  });
});
