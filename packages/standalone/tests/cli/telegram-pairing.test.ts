import { describe, expect, it } from 'vitest';
import {
  bindCommonGroup,
  confirmUpdates,
  pairOwner,
  type Update,
} from '../../src/cli/runtime/telegram-pairing.js';

const OWNER = 7101;
const STRANGER = 7999;
const GROUP = -7001;

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

/** A bot whose updates arrive in the order given; each getUpdates returns those at or after offset. */
function bot(initial: Update[] = []) {
  const queue = [...initial];
  const sent: Array<{ chat_id: string; text: string }> = [];
  const offsets: string[] = [];
  let conflict = false;
  const call = async (_token: string, method: string, params: Record<string, string> = {}) => {
    if (method === 'sendMessage') {
      sent.push({ chat_id: params.chat_id, text: params.text });
      return { ok: true, result: {} };
    }
    if (method === 'getUpdates') {
      offsets.push(params.offset);
      if (conflict) return { ok: false, error_code: 409 };
      const offset = Number(params.offset ?? 0);
      const pending = queue.filter((update) => update.update_id >= offset);
      if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true, result: pending };
    }
    throw new Error(`unexpected ${method}`);
  };
  return {
    call,
    sent,
    offsets,
    push: (update: Update) => queue.push(update),
    conflict: () => {
      conflict = true;
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
  it('sends each private sender a code and pairs whoever types theirs', async () => {
    const telegram = bot([dm(1, STRANGER), dm(2, OWNER)]);
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
    // Both got a code; only the code typed at the terminal names the owner.
    expect(telegram.sent.map((entry) => entry.chat_id).sort()).toEqual(
      [String(OWNER), String(STRANGER)].sort()
    );
    expect(lines).toContainEqual(expect.stringContaining('send any message to @fixture_bot'));
    expect(lines).toContainEqual(expect.stringContaining('not a code the bot sent'));
  });

  it("stops when another program reads the bot's messages, without waiting for typing", async () => {
    const telegram = bot();
    telegram.conflict();
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
    expect(telegram.offsets).toEqual([]);
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
    ).rejects.toThrow(/No \/bind arrived.*run mama init again/);
  });

  it('marks what init read as handled, so the daemon starts after it', async () => {
    const telegram = bot();
    await confirmUpdates({ token: 'fixture', call: telegram.call, write: () => {}, offset: 9 });
    expect(telegram.offsets).toEqual(['9']);
  });
});
