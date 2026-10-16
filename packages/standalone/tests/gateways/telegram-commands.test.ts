import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';

const seams = vi.hoisted(() => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
    setMyCommands: vi.fn().mockResolvedValue(true),
  },
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
}));

vi.mock('grammy', () => ({
  InputFile: vi.fn(),
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
      seams.handlers.set(event, handler);
    }),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 101, username: 'fixture_bot' },
    api: seams.api,
  })),
}));

import { TelegramGateway } from '../../src/gateways/telegram.js';
import {
  hostCommand,
  startOverText,
  statusText,
  type TelegramHostCommandPort,
} from '../../src/gateways/telegram-commands.js';
import type { OwnerMessageInput, TurnIntake } from '../../src/gateways/turn-contract.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const roots: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];
const COMMON = '-7001';
const OTHER_GROUP = '-7002';

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  seams.handlers.clear();
  seams.api.sendMessage.mockClear();
  seams.api.setMyCommands.mockReset().mockResolvedValue(true);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function command(text: string, overrides: Record<string, unknown> = {}) {
  const length = text.split(' ')[0].length;
  return {
    message_id: 21,
    date: 1_700_000_000,
    text,
    entities: [{ type: 'bot_command', offset: 0, length }],
    ...overrides,
  };
}

async function gateway(port: TelegramHostCommandPort, log: (line: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'mama-telegram-commands-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  const database = await openCoreDatabase({ path: join(root, 'principals.db') });
  databases.push(database);
  const registry = createPrincipalRepository(database.adapter);
  const owner = registry.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '7101',
    now: 1,
  });
  registry.grantRole({ principalId: owner, role: 'owner', now: 2 });
  const member = registry.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '7102',
    now: 3,
  });
  const received: OwnerMessageInput[] = [];
  const intake: TurnIntake = {
    recordOwnerReply: () => {},
    acceptOwnerMessage: (input) => {
      received.push(input);
      return { inputId: `input-${received.length}`, state: 'accepted' };
    },
  };
  const active = new TelegramGateway({
    token: 'fixture-token',
    intake,
    registry,
    memberIntake: () => intake,
    principalPaths: () => ({ downloadsDir: join(root, 'downloads') }),
    messageLedgerPath: join(root, 'ledger.json'),
    config: { allowedChats: [COMMON, OTHER_GROUP], ownerChatId: COMMON, polling: false },
    hostCommands: port,
    log,
  });
  await active.start();
  return { owner, member, received, registry };
}

async function send(message: Record<string, unknown>) {
  await seams.handlers.get('message')!({ message });
}

/** Commands are answered off the polling handler; wait for the reply. */
async function reply(): Promise<[number, string, { reply_parameters: { message_id: number } }]> {
  await vi.waitFor(() => expect(seams.api.sendMessage).toHaveBeenCalled());
  return seams.api.sendMessage.mock.calls[0];
}

function port(overrides: Partial<TelegramHostCommandPort> = {}): TelegramHostCommandPort {
  return {
    status: vi.fn(async () => ({
      version: '0.0.0-fixture',
      since: '2026-10-16 Fri 09:00',
      conversationRunning: false,
      inputsWaiting: 0,
    })),
    startOver: vi.fn(async () => 'started_over' as const),
    ...overrides,
  };
}

describe('hostCommand', () => {
  const name = () => 'fixture_bot';
  it('reads a known command at the start, with or without this bot named', () => {
    expect(hostCommand(command('/status'), name)).toBe('status');
    expect(hostCommand(command('/NEW now'), name)).toBe('new');
    expect(hostCommand(command('/whoami@Fixture_Bot'), name)).toBe('whoami');
  });

  it('leaves other bots, unknown commands and mid-text commands as messages', () => {
    expect(hostCommand(command('/status@other_bot'), name)).toBe('other_bot');
    expect(hostCommand(command('/report'), name)).toBeNull();
    expect(
      hostCommand(
        { text: 'see /status', entities: [{ type: 'bot_command', offset: 4, length: 7 }] },
        name
      )
    ).toBeNull();
    expect(hostCommand({ text: '/status' }, name)).toBeNull();
  });
});

describe('Telegram host commands', () => {
  it('registers the menu for private chats and groups', async () => {
    await gateway(port());
    expect(seams.api.setMyCommands).toHaveBeenCalledTimes(2);
    const scopes = seams.api.setMyCommands.mock.calls.map((call) => call[1].scope.type);
    expect(scopes).toEqual(['all_private_chats', 'all_group_chats']);
    expect(
      seams.api.setMyCommands.mock.calls[0][0].map((entry: { command: string }) => entry.command)
    ).toEqual(['whoami', 'status', 'new', 'help']);
  });

  it('starts even when the menu cannot be registered', async () => {
    seams.api.setMyCommands.mockRejectedValue(new Error('fixture menu refused'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { received } = await gateway(port());
    await send({
      ...command('/help'),
      chat: { id: 7102, type: 'private' },
      from: { id: 7102, is_bot: false },
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('telegram command menu failed'));
    await reply();
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(0);
    error.mockRestore();
  });

  it('answers /whoami in a DM without a turn', async () => {
    const { member, received } = await gateway(port());
    await send({
      ...command('/whoami'),
      chat: { id: 7102, type: 'private' },
      from: { id: 7102, is_bot: false },
    });
    const [chatId, text, options] = await reply();
    expect(received).toHaveLength(0);
    expect(chatId).toBe(7102);
    expect(text).toContain('Telegram ID: 7102');
    expect(text).toContain(`a member (${member})`);
    expect(options.reply_parameters.message_id).toBe(21);
  });

  it('routes an owner in the common group to the common session', async () => {
    const status = vi.fn(async (_target: unknown, ownerView: boolean) => ({
      version: '0.0.0-fixture',
      since: '2026-10-16 Fri 09:00',
      conversationRunning: true,
      inputsWaiting: 2,
      ...(ownerView
        ? { owner: { turnsRunning: 1, sources: [{ name: 'fixture-source', healthy: false }] } }
        : {}),
    }));
    const commands = port({ status });
    await gateway(commands);
    await send({
      ...command('/status@fixture_bot'),
      chat: { id: Number(COMMON), type: 'supergroup' },
      from: { id: 7101, is_bot: false },
    });
    const [, text] = await reply();
    // The group reads the reply, so the owner's view of every conversation stays in their DM.
    expect(status).toHaveBeenCalledWith({ kind: 'common' }, false);
    expect(text).toContain('This conversation: a turn is running');
    expect(text).toContain('Inputs not yet done: 2');
    expect(text).not.toContain('fixture-source');
    seams.api.sendMessage.mockClear();
    await send({
      ...command('/status'),
      chat: { id: 7101, type: 'private' },
      from: { id: 7101, is_bot: false },
    });
    const [, dm] = await reply();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'member' }), true);
    expect(dm).toContain('1 turns running, 2 inputs not yet done');
    expect(dm).toContain('failing: fixture-source');
  });

  it('routes a member in the common group to their own room, not the common session', async () => {
    const commands = port();
    const { member } = await gateway(commands);
    await send({
      ...command('/new'),
      chat: { id: Number(COMMON), type: 'supergroup' },
      from: { id: 7102, is_bot: false },
    });
    const [, text] = await reply();
    expect(commands.startOver).toHaveBeenCalledWith({
      kind: 'member',
      principalId: member,
      room: COMMON,
    });
    expect(text).toContain('the next message here');
  });

  it('says a busy conversation keeps its turn', async () => {
    const commands = port({ startOver: vi.fn(async () => 'busy' as const) });
    const { owner } = await gateway(commands);
    await send({
      ...command('/new'),
      chat: { id: 7101, type: 'private' },
      from: { id: 7101, is_bot: false },
    });
    const [, text] = await reply();
    expect(commands.startOver).toHaveBeenCalledWith({ kind: 'member', principalId: owner });
    expect(text).toContain('MAMA is still busy with work that would carry into a new conversation');
  });

  it('answers a failed command with a notice and keeps the error in the log', async () => {
    const lines: string[] = [];
    const commands = port({
      startOver: vi.fn(async () => Promise.reject(new Error('fixture reset failed'))),
    });
    await gateway(commands, (line) => lines.push(line));
    await send({
      ...command('/new'),
      chat: { id: 7102, type: 'private' },
      from: { id: 7102, is_bot: false },
    });
    const [, text] = await reply();
    expect(text).toBe('MAMA could not answer /new; its log has the error.');
    expect(lines).toContainEqual(expect.stringContaining('fixture reset failed'));
  });

  it('names only the common channel as such, and answers there for an owner', async () => {
    await gateway(port());
    await send({
      ...command('/whoami'),
      chat: { id: Number(OTHER_GROUP), type: 'supergroup' },
      from: { id: 7102, is_bot: false },
    });
    const [, text] = await reply();
    expect(text).toContain(`This group (${OTHER_GROUP}) is a group MAMA admits`);
    expect(text).toContain('your own conversation for this group');
    seams.api.sendMessage.mockClear();
    await send({
      ...command('/whoami'),
      chat: { id: Number(COMMON), type: 'supergroup' },
      from: { id: 7101, is_bot: false },
    });
    const [, common] = await reply();
    expect(common).toContain(`This group (${COMMON}) is MAMA's common channel`);
    expect(common).toContain('the common session');
  });

  it('ignores a command addressed to another bot', async () => {
    const { received } = await gateway(port());
    await send({
      ...command('/status@other_bot'),
      chat: { id: Number(COMMON), type: 'supergroup' },
      from: { id: 7101, is_bot: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seams.api.sendMessage).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it('answers no suspended member and no group MAMA does not admit', async () => {
    const commands = port();
    const { member, registry } = await gateway(commands);
    await send({
      ...command('/status'),
      chat: { id: -7999, type: 'supergroup' },
      from: { id: 7101, is_bot: false },
    });
    registry.suspend(member, 4);
    await send({
      ...command('/new'),
      chat: { id: 7102, type: 'private' },
      from: { id: 7102, is_bot: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seams.api.sendMessage).not.toHaveBeenCalled();
    expect(commands.status).not.toHaveBeenCalled();
    expect(commands.startOver).not.toHaveBeenCalled();
  });

  it('leaves strangers unanswered and unknown commands as messages', async () => {
    const { received } = await gateway(port());
    await send({
      ...command('/whoami'),
      chat: { id: 7999, type: 'private' },
      from: { id: 7999, is_bot: false },
    });
    expect(seams.api.sendMessage).not.toHaveBeenCalled();
    await send({
      ...command('/report today'),
      chat: { id: 7102, type: 'private' },
      from: { id: 7102, is_bot: false },
    });
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('/report today');
  });
});

describe('command texts', () => {
  it('shows members only their own waiting inputs', () => {
    expect(
      statusText({
        version: '1.2.3',
        since: '2026-10-16 Fri 09:00',
        conversationRunning: false,
        inputsWaiting: 3,
      })
    ).toEqual([
      'MAMA 1.2.3, running since 2026-10-16 Fri 09:00',
      'This conversation: idle',
      'Inputs not yet done: 3',
    ]);
  });

  it('says a DM reset reaches the group conversations too', () => {
    const dm = { kind: 'member' as const, principalId: 'p' };
    expect(startOverText('started_over', dm, false)).toContain('here or in a group');
    // An owner's group messages go to the common session, which a DM /new leaves alone.
    expect(startOverText('started_over', dm, true)).toContain('the common group goes on');
    expect(startOverText('started_over', { kind: 'common' }, true)).toContain(
      'the next message here'
    );
  });
});
