/**
 * Connecting a person's own account in their Telegram DM (approvals.md, P2; owner, 2026-11-17:
 * entered in Telegram, which works on a phone). The host asks in that DM with a reply prompt; the
 * person's reply to that prompt, within 15 minutes, is the token. The gateway hands every reply to
 * an account prompt to the host before anything records it, so a token never reaches a turn, the
 * conversation or a trace: a reply that comes late, after a restart, or as a caption is deleted and
 * the person is asked to start again (#589 review). The host deletes the reply from the chat, checks
 * it with the service and stores it (account-store). The token passes Telegram's servers, as every
 * bot message does.
 */
import type { AccountService, AccountStore } from './account-store.js';

export const CONNECT_WINDOW_MS = 15 * 60_000;

/** Every account prompt starts so: a reply to one is the host's, whatever the host remembers. */
export const ACCOUNT_PROMPT_PREFIX = 'Reply to this message with your ';

const SERVICE_NAMES: Record<AccountService, string> = { chatwork: 'Chatwork', slack: 'Slack' };

const HOW_TO: Record<AccountService, string> = {
  chatwork: 'your Chatwork API token (Chatwork: Service connection → API token)',
  slack: 'your Slack user token (xoxp-…, from a Slack app installed for you with chat:write)',
};

export interface AccountConnectPorts {
  accounts: AccountStore;
  /** The account a token belongs to; rejects when the service refuses the token. */
  identify(
    service: AccountService,
    token: string
  ): Promise<{ id: string; name: string; bot?: boolean }>;
  /** The person's own Telegram DM. */
  dmChatOf(principalId: string): string;
  /** Sends the reply prompt; resolves with its message id. */
  prompt(chatId: string, text: string): Promise<number>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  say(chatId: string, text: string): Promise<void>;
  log(line: string): void;
  /** Whether the person may still hold an account (an active owner-role member). */
  mayConnect(principalId: string): boolean;
  now?: () => number;
}

export interface AccountReply {
  chatId: string;
  principalId: string;
  messageId: number;
  /** The message's text, or its caption; undefined for neither. */
  text: string | undefined;
  /** The message it replies to, when it is a reply to this bot. */
  replyTo?: { messageId: number; text: string | undefined };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAccountConnect(ports: AccountConnectPorts) {
  const now = ports.now ?? Date.now;
  /** Waiting prompts, by DM and prompt message: each reply answers its own prompt. */
  const waiting = new Map<
    string,
    { principalId: string; service: AccountService; expiresAt: number }
  >();
  const key = (chatId: string, messageId: number) => `${chatId}:${messageId}`;

  /** A reply to an account prompt nobody is waiting on: taken off the chat, never passed on. */
  const stale = async (reply: AccountReply) => {
    let note = '';
    try {
      await ports.deleteMessage(reply.chatId, reply.messageId);
    } catch (error) {
      ports.log(`account stale reply delete failed: ${reason(error)}`);
      note = ' I could not delete your message: delete it yourself.';
    }
    await ports.say(
      reply.chatId,
      `That prompt is no longer waiting (it expired, or MAMA restarted). Nothing was saved; ask again to connect.${note}`
    );
  };

  const complete = async (reply: AccountReply, service: AccountService) => {
    const name = SERVICE_NAMES[service];
    let note = '';
    try {
      await ports.deleteMessage(reply.chatId, reply.messageId);
    } catch (error) {
      ports.log(`account ${service} token message delete failed: ${reason(error)}`);
      note = ' I could not delete your message: delete it yourself.';
    }
    const token = (reply.text ?? '').trim();
    let account: { id: string; name: string; bot?: boolean };
    try {
      account = await ports.identify(service, token);
    } catch (error) {
      await ports.say(
        reply.chatId,
        `That ${name} token did not work (${reason(error)}). Nothing was saved; ask again to retry.${note}`
      );
      return;
    }
    if (account.bot) {
      await ports.say(
        reply.chatId,
        `That is a bot token. A message from your DM posts as you: send your own user token instead. Nothing was saved; ask again to retry.${note}`
      );
      return;
    }
    // Offboarded or no longer an owner while the service answered: nothing is kept for them.
    if (!ports.mayConnect(reply.principalId)) {
      await ports.say(
        reply.chatId,
        `Nothing was saved: you may no longer connect accounts.${note}`
      );
      return;
    }
    ports.accounts.set(reply.principalId, service, {
      token,
      accountId: account.id,
      name: account.name,
    });
    await ports.say(
      reply.chatId,
      `Connected ${name} as ${account.name} (${account.id}). Messages you approve from this DM now post as this account.${note}`
    );
  };

  return {
    async ask(principalId: string, service: AccountService): Promise<{ expiresAt: number }> {
      const chatId = ports.dmChatOf(principalId);
      const expiresAt = now() + CONNECT_WINDOW_MS;
      const promptId = await ports.prompt(
        chatId,
        `${ACCOUNT_PROMPT_PREFIX}${HOW_TO[service]}, within 15 minutes. The host reads your reply, deletes it from this chat and stores it; it never reaches the agent or the conversation.`
      );
      waiting.set(key(chatId, promptId), { principalId, service, expiresAt });
      return { expiresAt };
    },

    /**
     * The gateway's check for every DM message, before it is recorded: a completion for every
     * reply to an account prompt (the token, or a stale reply to delete), else null. Taken once.
     */
    claim(reply: AccountReply): (() => Promise<void>) | null {
      if (!reply.replyTo?.text?.startsWith(ACCOUNT_PROMPT_PREFIX)) return null;
      const id = key(reply.chatId, reply.replyTo.messageId);
      const pending = waiting.get(id);
      waiting.delete(id);
      if (
        !pending ||
        pending.principalId !== reply.principalId ||
        now() > pending.expiresAt ||
        reply.text === undefined
      )
        return () => stale(reply);
      return () => complete(reply, pending.service);
    },
  };
}

export type AccountConnect = ReturnType<typeof createAccountConnect>;
