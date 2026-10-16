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
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
  };
}

interface PairingOptions {
  token: string;
  call: TelegramCall;
  write: (line: string) => void;
  /** Seconds each getUpdates waits for news; doctor's call gives up after eight. */
  pollSeconds?: number;
}

/** At most this many people get a code in one window; anyone after that is ignored. */
const MAX_CODES = 10;
/** How long init waits for /bind before it stops and says how to continue. */
const BIND_WAIT_MS = 15 * 60_000;

async function updates(options: PairingOptions, offset: number): Promise<Update[]> {
  const reply = await options.call(options.token, 'getUpdates', {
    offset: String(offset),
    timeout: String(options.pollSeconds ?? 5),
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

async function send(options: PairingOptions, chatId: number, text: string): Promise<void> {
  const reply = await options.call(options.token, 'sendMessage', { chat_id: String(chatId), text });
  if (reply.ok !== true)
    throw new CliInputError(`Telegram refused to send a message (${String(reply.error_code)}).`);
}

/**
 * Make the person at the terminal the first owner without a typed user ID: everyone who messages
 * the bot privately while init waits gets a code, and the code typed here names the owner. A
 * code reaches only the chat it was sent to, so typing it proves that chat is this person's.
 */
export async function pairOwner(
  options: PairingOptions & {
    botUsername: string;
    /** Ends with a rejection once the signal aborts: a failed poll must not wait for typing. */
    ask: (label: string, signal: AbortSignal) => Promise<string>;
  }
): Promise<{ ownerId: string; offset: number; groupMessages: Update[] }> {
  options.write(
    `Open Telegram and send any message to @${options.botUsername}. It answers with a pairing code; type that code here.`
  );
  const codes = new Map<string, string>();
  const senders = new Set<string>();
  // Group messages read while waiting for the code: a /bind sent early must not be lost.
  const groupMessages: Update[] = [];
  let offset = 0;
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
        const code = String(randomInt(100_000, 1_000_000));
        senders.add(sender);
        codes.set(code, sender);
        await send(
          options,
          message.chat.id,
          `Your MAMA pairing code: ${code}\nType it in the terminal where mama init runs.`
        );
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
        options.write('That is not a code the bot sent; type the code from its latest message.');
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
  for (;;) {
    for (const update of batch) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (!message?.chat || !message.from) continue;
      if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') continue;
      if (String(message.from.id) !== options.ownerId || !isBind(message, options.botUsername))
        continue;
      await send(options, message.chat.id, "This group is now MAMA's common channel.");
      return { chatId: String(message.chat.id), offset };
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
  await updates({ ...options, pollSeconds: 0 }, options.offset);
}
