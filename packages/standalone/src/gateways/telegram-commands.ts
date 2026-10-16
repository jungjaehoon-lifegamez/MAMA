import type { Context } from 'grammy';
import type { ConversationTarget } from './turn-contract.js';

type TelegramMessage = NonNullable<Context['message']>;

/**
 * Commands the host answers itself, before any turn: the menu the bot registers and the list
 * /help prints. Any other command text goes to MAMA as an ordinary message.
 */
export const TELEGRAM_HOST_COMMANDS = [
  { command: 'whoami', description: 'Your Telegram ID and how MAMA knows you' },
  { command: 'status', description: 'Whether MAMA is working, and on what' },
  { command: 'new', description: 'Start this conversation over' },
  { command: 'help', description: 'The commands MAMA answers itself' },
] as const;

export type TelegramHostCommand = (typeof TELEGRAM_HOST_COMMANDS)[number]['command'];

/** What the daemon does for a host command; the gateway only parses, routes and replies. */
export interface TelegramHostCommandPort {
  status(target: ConversationTarget, owner: boolean): Promise<ChatStatus>;
  /** Start the conversation over, or say it is busy: a running turn keeps its session. */
  startOver(target: ConversationTarget): Promise<'started_over' | 'busy'>;
}

/**
 * The host command a message opens with, or null. A command addressed to another bot
 * (`/status@other_bot`) is not this bot's; an unknown one stays an ordinary message.
 */
export function hostCommand(
  message: Pick<TelegramMessage, 'text' | 'entities'>,
  botUsername: () => string
): TelegramHostCommand | null {
  const first = message.entities?.[0];
  if (!message.text || first?.type !== 'bot_command' || first.offset !== 0) return null;
  const [name, addressee] = message.text.slice(1, first.length).split('@', 2);
  if (addressee !== undefined && addressee.toLowerCase() !== botUsername().toLowerCase())
    return null;
  const command = name.toLowerCase();
  return TELEGRAM_HOST_COMMANDS.some((entry) => entry.command === command)
    ? (command as TelegramHostCommand)
    : null;
}

export function helpText(): string {
  return [
    'Commands MAMA answers itself, without a turn:',
    ...TELEGRAM_HOST_COMMANDS.map(({ command, description }) => `/${command}: ${description}`),
    'Anything else goes to MAMA as a message.',
  ].join('\n');
}

export function whoamiText(input: {
  userId: string;
  chatId: string;
  privateChat: boolean;
  principalId: string;
  owner: boolean;
}): string {
  const lines = [
    `Telegram ID: ${input.userId}`,
    `MAMA knows you as ${input.owner ? 'an owner' : 'a member'} (${input.principalId}).`,
  ];
  if (!input.privateChat) {
    lines.push(
      input.owner
        ? `This group (${input.chatId}) is MAMA's common channel; your messages here run in the common session.`
        : `This group (${input.chatId}) is MAMA's common channel; your messages here run in your own conversation for this group.`
    );
  }
  return lines.join('\n');
}

export function startOverText(result: 'started_over' | 'busy', target: ConversationTarget): string {
  // A member's own conversation is reset with their group conversations (member-session.ts).
  const memberDm = target.kind === 'member' && target.room === undefined;
  if (result === 'busy')
    return memberDm
      ? 'A turn is running in one of your conversations with MAMA. Wait for its answer, then send /new again.'
      : 'A turn is running in this conversation. Wait for its answer, then send /new again.';
  return memberDm
    ? 'Started over: your next message, here or in a group, begins a new conversation. What MAMA has saved stays.'
    : 'Started over: the next message here begins a new conversation. What MAMA has saved stays.';
}

/** What /status reports; counts beyond the asker's own appear only for owners. */
export interface ChatStatus {
  version: string;
  /** When this daemon started, in the owner's time zone. */
  since: string;
  conversationRunning: boolean;
  /** Owners: inputs waiting in every conversation; members: their own. */
  inputsWaiting: number;
  owner?: {
    turnsRunning: number;
    sources: Array<{ name: string; healthy: boolean }>;
  };
}

export function statusText(status: ChatStatus): string[] {
  const lines = [
    `MAMA ${status.version}, running since ${status.since}`,
    `This conversation: ${status.conversationRunning ? 'a turn is running' : 'idle'}`,
  ];
  if (status.owner === undefined) {
    lines.push(`Your messages waiting: ${status.inputsWaiting}`);
    return lines;
  }
  lines.push(
    `All conversations: ${status.owner.turnsRunning} turns running, ${status.inputsWaiting} inputs waiting`
  );
  const failing = status.owner.sources.filter((source) => !source.healthy);
  if (status.owner.sources.length > 0)
    lines.push(
      `Sources: ${status.owner.sources.length - failing.length} of ${status.owner.sources.length} polling` +
        (failing.length > 0 ? `; failing: ${failing.map((source) => source.name).join(', ')}` : '')
    );
  return lines;
}
