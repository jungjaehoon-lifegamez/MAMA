import { describe, expect, it } from 'vitest';
import {
  bindCommonGroup,
  botName,
  confirmUpdates,
  pairOwner,
  type Update,
} from '../../src/cli/runtime/telegram-pairing.js';

const OWNER = 7101;
const STRANGER = 7999;
const GROUP = -7001;
const OTHER_GROUP = -7002;
/** The account Telegram shows as the sender of an anonymous administrator's message. */
const ANONYMOUS_ADMIN = 7555;

function dm(updateId: number, from: number, text = 'hello'): Update {
  return {
    update_id: updateId,
    message: { chat: { id: from, type: 'private' }, from: { id: from }, text },
  };
}

function command(updateId: number, chat: number, type: string, from: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      chat: { id: chat, type },
      from: { id: from },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  };
}

/**
 * A bot with Telegram's update queue: `held` waited before init started, `arriving` comes after
 * init's first poll. A negative offset keeps only the newest updates; a positive one confirms
 * the updates before it.
 */
function bot(held: Update[] = [], arriving: Update[] = []) {
  let queue = [...held];
  let arrived = false;
  const sent: Array<{ chat_id: string; text: string }> = [];
  const polls: Array<{ offset: string; timeout: string }> = [];
  const refusing = new Set<string>();
  let conflictAfter = Infinity;
  const call = async (_token: string, method: string, params: Record<string, string> = {}) => {
    if (method === 'sendMessage') {
      if (refusing.has(params.chat_id)) return { ok: false, error_code: 403 };
      sent.push({ chat_id: params.chat_id, text: params.text });
      return { ok: true, result: {} };
    }
    if (method === 'getUpdates') {
      polls.push({ offset: params.offset, timeout: params.timeout });
      if (polls.length > conflictAfter) return { ok: false, error_code: 409 };
      const offset = Number(params.offset ?? 0);
      queue = offset < 0 ? queue.slice(offset) : queue.filter((u) => u.update_id >= offset);
      const result = [...queue];
      if (!arrived) {
        arrived = true;
        queue.push(...arriving);
      }
      if (result.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true, result };
    }
    throw new Error(`unexpected ${method}`);
  };
  return {
    call,
    sent,
    polls,
    refuse: (chat: number) => refusing.add(String(chat)),
    conflictAfter: (count: number) => {
      conflictAfter = count;
    },
    codeFor: async (chat: number) => {
      for (;;) {
        const message = sent.find((entry) => entry.chat_id === String(chat));
        if (message) return /(\d{6})/.exec(message.text)![1];
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}

describe('pairing the first owner', () => {
  it('sends each private sender a code and pairs whoever enters theirs', async () => {
    const telegram = bot([], [dm(1, STRANGER), dm(2, OWNER)]);
    const lines: string[] = [];
    const answers = ['000000'];
    const paired = await pairOwner({
      token: 'fixture',
      call: telegram.call,
      write: (line) => lines.push(line),
      botUsername: 'fixture_bot',
      ask: async () => answers.shift() ?? (await telegram.codeFor(OWNER)),
    });
    expect(paired.ownerId).toBe(String(OWNER));
    expect(paired.offset).toBe(3);
    // Both got a code; only the code entered names the owner.
    expect(telegram.sent.map((entry) => entry.chat_id).sort()).toEqual(
      [String(OWNER), String(STRANGER)].sort()
    );
    expect(lines).toContainEqual(
      expect.stringContaining('send @fixture_bot a new private message')
    );
    expect(lines).toContainEqual(expect.stringContaining('not a code the bot sent'));
  });

  it('drops what the bot held from before setup, an old /bind included', async () => {
    const telegram = bot(
      [dm(1, STRANGER), command(2, GROUP, 'supergroup', OWNER, '/bind')],
      [dm(3, OWNER)]
    );
    const paired = await pairOwner({
      token: 'fixture',
      call: telegram.call,
      write: () => {},
      botUsername: 'fixture_bot',
      ask: () => telegram.codeFor(OWNER),
    });
    expect(telegram.polls[0]).toEqual({ offset: '-1', timeout: '0' });
    expect(telegram.sent.map((entry) => entry.chat_id)).toEqual([String(OWNER)]);
    expect(paired).toMatchObject({ ownerId: String(OWNER), offset: 4, groupMessages: [] });
  });

  it('skips a chat that refuses its code and goes on pairing', async () => {
    const telegram = bot([], [dm(1, STRANGER), dm(2, OWNER)]);
    telegram.refuse(STRANGER);
    const lines: string[] = [];
    const paired = await pairOwner({
      token: 'fixture',
      call: telegram.call,
      write: (line) => lines.push(line),
      botUsername: 'fixture_bot',
      ask: () => telegram.codeFor(OWNER),
    });
    expect(paired.ownerId).toBe(String(OWNER));
    expect(lines).toContainEqual(expect.stringContaining('refused to deliver a pairing code'));
  });

  it("stops when another program reads the bot's messages, without waiting for typing", async () => {
    const telegram = bot();
    telegram.conflictAfter(1);
    await expect(
      pairOwner({
        token: 'fixture',
        call: telegram.call,
        write: () => {},
        botUsername: 'fixture_bot',
        // Nobody types: only the aborted question ends the wait.
        ask: (_label, signal) =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('Input cancelled')))
          ),
      })
    ).rejects.toThrow(/Another program is reading this bot's messages/);
  });

  it("reads the bot's name, and names a refused token", async () => {
    const reply = (ok: boolean) => async () =>
      ok ? { ok: true, result: { username: 'fixture_bot' } } : { ok: false, error_code: 401 };
    expect(await botName({ token: 'fixture', call: reply(true), write: () => {} })).toBe(
      'fixture_bot'
    );
    await expect(
      botName({ token: 'fixture', call: reply(false), write: () => {} })
    ).rejects.toThrow(/refused the bot token/);
  });

  it('names a network failure in a sentence', async () => {
    await expect(
      pairOwner({
        token: 'fixture',
        call: async () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        },
        write: () => {},
        botUsername: 'fixture_bot',
        ask: async () => '123456',
      })
    ).rejects.toThrow(/Could not reach Telegram \(ENOTFOUND\); check the network/);
  });
});

describe('binding the common group', () => {
  it("takes only the owner's /bind in a group, and says so there", async () => {
    const telegram = bot([
      command(5, GROUP, 'supergroup', STRANGER, '/bind'),
      command(6, OWNER, 'private', OWNER, '/bind'),
      command(7, GROUP, 'supergroup', OWNER, '/bind@other_bot'),
      command(8, GROUP, 'supergroup', OWNER, '/bind@Fixture_Bot'),
    ]);
    const bound = await bindCommonGroup({
      token: 'fixture',
      call: telegram.call,
      write: () => {},
      botUsername: 'fixture_bot',
      ownerId: String(OWNER),
      offset: 5,
    });
    expect(bound).toEqual({ chatId: String(GROUP), offset: 9 });
    expect(telegram.sent).toEqual([
      { chat_id: String(GROUP), text: "This group is now MAMA's common channel." },
    ]);
  });

  it('keeps a /bind the owner sent before pairing finished', async () => {
    const telegram = bot();
    const early = command(3, GROUP, 'group', OWNER, '/bind');
    const bound = await bindCommonGroup({
      token: 'fixture',
      call: telegram.call,
      write: () => {},
      botUsername: 'fixture_bot',
      ownerId: String(OWNER),
      offset: 4,
      earlier: [early],
    });
    expect(bound.chatId).toBe(String(GROUP));
    expect(telegram.polls).toEqual([]);
  });

  it("tells an anonymous administrator's /bind cannot count, and waits for the owner's", async () => {
    const anonymous = command(5, GROUP, 'supergroup', ANONYMOUS_ADMIN, '/bind');
    anonymous.message!.sender_chat = { id: GROUP };
    const telegram = bot([anonymous, command(6, GROUP, 'supergroup', OWNER, '/bind')]);
    const lines: string[] = [];
    const bound = await bindCommonGroup({
      token: 'fixture',
      call: telegram.call,
      write: (line) => lines.push(line),
      botUsername: 'fixture_bot',
      ownerId: String(OWNER),
      offset: 5,
    });
    expect(bound.chatId).toBe(String(GROUP));
    expect(lines).toContainEqual(expect.stringContaining("Turn off 'Remain anonymous'"));
  });

  it('waits on when the bot cannot post in the group the /bind came from', async () => {
    const telegram = bot([
      command(5, OTHER_GROUP, 'group', OWNER, '/bind'),
      command(6, GROUP, 'group', OWNER, '/bind'),
    ]);
    telegram.refuse(OTHER_GROUP);
    const lines: string[] = [];
    const bound = await bindCommonGroup({
      token: 'fixture',
      call: telegram.call,
      write: (line) => lines.push(line),
      botUsername: 'fixture_bot',
      ownerId: String(OWNER),
      offset: 5,
    });
    expect(bound.chatId).toBe(String(GROUP));
    expect(lines).toContainEqual(expect.stringContaining('refused to let the bot post'));
  });

  it('gives up after its wait with the way to continue', async () => {
    const telegram = bot();
    let clock = 0;
    await expect(
      bindCommonGroup({
        token: 'fixture',
        call: telegram.call,
        write: () => {},
        botUsername: 'fixture_bot',
        ownerId: String(OWNER),
        offset: 1,
        now: () => (clock += 1000),
        waitMs: 3000,
      })
    ).rejects.toThrow(/No \/bind arrived.*run the install command again/);
  });

  it('marks what init read as handled, so the daemon starts after it', async () => {
    const telegram = bot();
    await confirmUpdates({ token: 'fixture', call: telegram.call, write: () => {}, offset: 9 });
    expect(telegram.polls).toEqual([{ offset: '9', timeout: '0' }]);
  });
});
