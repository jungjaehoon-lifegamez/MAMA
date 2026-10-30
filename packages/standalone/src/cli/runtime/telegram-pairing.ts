import { randomInt } from 'node:crypto';
import { CliInputError } from '../prompt.js';

/** One Telegram Bot API call, as doctor makes it; tests replace it. */
export type TelegramCall = (
  token: string,
  method: string,
  params?: Record<string, string>
) => Promise<Record<string, unknown>>;

export interface Update {
  update_id: number;
  message?: {
    chat?: { id: number; type?: string };
    from?: { id: number; is_bot?: boolean };
    /** Set when an anonymous administrator posts as the group itself. */
    sender_chat?: { id: number };
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
  };
}

interface PairingOptions {
  token: string;
  call: TelegramCall;
  write: (line: string) => void;
}

/** At most this many people get a code in one window; anyone after that is ignored. */
const MAX_CODES = 10;
/** How long init waits for /bind before it stops and says how to continue. */
const BIND_WAIT_MS = 15 * 60_000;

/** A call whose network failure ends init with a sentence, not an unnamed error. */
async function request(
  options: PairingOptions,
  method: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  try {
    return await options.call(options.token, method, params);
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    const name = error instanceof Error ? error.name : 'Error';
    throw new CliInputError(
      `Could not reach Telegram (${typeof cause === 'string' ? cause : name}); check the network and run mama init again.`
    );
  }
}

/** Each getUpdates waits up to five seconds for news; doctor's call gives up after eight. */
async function updates(
  options: PairingOptions,
  offset: number,
  pollSeconds = 5
): Promise<Update[]> {
  const reply = await request(options, 'getUpdates', {
    offset: String(offset),
    timeout: String(pollSeconds),
    allowed_updates: JSON.stringify(['message']),
  });
  if (reply.ok === true) return (reply.result as Update[] | undefined) ?? [];
  // Telegram lets one reader at a time take a bot's updates; init and a daemon would keep
  // stopping each other.
  if (reply.error_code === 409)
    throw new CliInputError(
      "Another program is reading this bot's messages (another MAMA install?). Use a bot only this install uses, then run mama init again."
    );
  throw new CliInputError(
    `Telegram refused to hand over the bot's messages (${String(reply.error_code ?? 'no code')}).`
  );
}

/** The bot's @name, which the pairing instructions give. */
export async function botName(options: PairingOptions): Promise<string> {
  const reply = await request(options, 'getMe', {});
  const name = (reply.result as { username?: unknown } | undefined)?.username;
  if (reply.ok !== true || typeof name !== 'string')
    throw new CliInputError('Telegram refused the bot token; copy it again from BotFather.');
  return name;
}

async function send(options: PairingOptions, chatId: number, text: string): Promise<boolean> {
  const reply = await request(options, 'sendMessage', { chat_id: String(chatId), text });
  return reply.ok === true;
}

/**
 * Make the person setting up the first owner without a typed user ID: everyone who messages the
 * bot privately while init waits gets a code, and the code `ask` returns names the owner. A code
 * reaches only the chat it was sent to, so entering it proves that chat is this person's.
 * Messages the bot held from before are dropped first: they were not sent to this setup, and an
 * old /bind would otherwise name a group without a new word from the owner.
 */
export async function pairOwner(
  options: PairingOptions & {
    botUsername: string;
    /** Ends with a rejection once the signal aborts: a failed poll must not wait for typing. */
    ask: (label: string, signal: AbortSignal) => Promise<string>;
  }
): Promise<{ ownerId: string; offset: number; groupMessages: Update[] }> {
  // offset -1 returns only the newest held update and drops the rest; the next poll drops it too.
  const held = await updates(options, -1, 0);
  let offset = held.length > 0 ? held[held.length - 1].update_id + 1 : 0;
  options.write(
    `Open Telegram and send @${options.botUsername} a new private message (one sent before now is dropped). It answers with a pairing code; enter it on the setup page.`
  );
  const codes = new Map<string, string>();
  const senders = new Set<string>();
  // Group messages read while waiting for the code: a /bind sent early must not be lost.
  const groupMessages: Update[] = [];
  let stopped = false;
  let failure: unknown;
  const pollingFailed = new AbortController();
  const polling = (async () => {
    while (!stopped) {
      for (const update of await updates(options, offset)) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        if (message?.chat?.type === 'group' || message?.chat?.type === 'supergroup')
          groupMessages.push(update);
        if (!message?.chat || message.chat.type !== 'private' || !message.from) continue;
        if (message.from.is_bot) continue;
        const sender = String(message.from.id);
        if (senders.has(sender) || senders.size >= MAX_CODES) continue;
        let code: string;
        do code = String(randomInt(100_000, 1_000_000));
        while (codes.has(code));
        senders.add(sender);
        codes.set(code, sender);
        const sent = await send(
          options,
          message.chat.id,
          `Your MAMA pairing code: ${code}\nEnter it on the setup page.`
        );
        // A chat that refuses the bot (blocked it, account gone) cannot show its code; that sender
        // may unblock the bot and write again.
        if (!sent) {
          senders.delete(sender);
          codes.delete(code);
          options.write(
            'Telegram refused to deliver a pairing code to one chat. If it was yours, unblock the bot and send it another message.'
          );
        }
      }
    }
  })().catch((error: unknown) => {
    failure = error;
    pollingFailed.abort();
  });
  let ownerId: string | undefined;
  try {
    while (ownerId === undefined) {
      let answer: string;
      try {
        answer = (await options.ask('Pairing code (from the bot)', pollingFailed.signal)).trim();
      } catch (error) {
        throw failure ?? error;
      }
      if (failure !== undefined) throw failure;
      ownerId = codes.get(answer);
      if (ownerId === undefined)
        options.write('That is not a code the bot sent; enter the code from its latest message.');
    }
  } finally {
    stopped = true;
    await polling;
  }
  // Read after polling stopped, so every update it handled is counted.
  return { ownerId, offset, groupMessages };
}

/** A `/bind` command at the start of a message, unaddressed or addressed to this bot. */
function isBind(message: NonNullable<Update['message']>, botUsername: string): boolean {
  const first = message.entities?.[0];
  if (!message.text || first?.type !== 'bot_command' || first.offset !== 0) return false;
  const [name, addressee] = message.text.slice(1, first.length).split('@', 2);
  return (
    name.toLowerCase() === 'bind' &&
    (addressee === undefined || addressee.toLowerCase() === botUsername.toLowerCase())
  );
}

/**
 * The common channel without a typed chat ID: the paired owner sends /bind in the group, and
 * that group becomes it. Anyone else's message, or a /bind in a private chat, is ignored.
 */
export async function bindCommonGroup(
  options: PairingOptions & {
    botUsername: string;
    ownerId: string;
    offset: number;
    /** Group messages read before this step, checked first. */
    earlier?: readonly Update[];
    now?: () => number;
    waitMs?: number;
  }
): Promise<{ chatId: string; offset: number }> {
  options.write(
    `Add @${options.botUsername} to the group for common work as an administrator (so it reads the group), then send /bind in that group.`
  );
  const now = options.now ?? Date.now;
  const deadline = now() + (options.waitMs ?? BIND_WAIT_MS);
  let offset = options.offset;
  let batch: readonly Update[] = options.earlier ?? [];
  let toldAnonymous = false;
  for (;;) {
    for (const update of batch) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (!message?.chat || !message.from) continue;
      if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') continue;
      if (!isBind(message, options.botUsername)) continue;
      // An anonymous administrator's message names the group, not the person, so it cannot count.
      if (message.sender_chat !== undefined && !toldAnonymous) {
        toldAnonymous = true;
        options.write(
          "A /bind came from an anonymous administrator, so it cannot count as yours. Turn off 'Remain anonymous' for yourself in the group's administrator settings and send /bind again."
        );
      }
      if (message.sender_chat !== undefined || String(message.from.id) !== options.ownerId)
        continue;
      // MAMA posts reports and notices there, so a group the bot cannot post in cannot be it.
      if (await send(options, message.chat.id, "This group is now MAMA's common channel."))
        return { chatId: String(message.chat.id), offset };
      options.write(
        'Telegram refused to let the bot post in that group. Let it post there, then send /bind again.'
      );
    }
    if (now() >= deadline)
      throw new CliInputError('No /bind arrived in the group; run mama init again to pair again.');
    batch = await updates(options, offset);
  }
}

/**
 * Mark every update init read as handled, so the daemon's first poll does not take the pairing
 * messages for an owner's questions.
 */
export async function confirmUpdates(options: PairingOptions & { offset: number }): Promise<void> {
  if (options.offset === 0) return;
  await updates(options, options.offset, 0);
}
