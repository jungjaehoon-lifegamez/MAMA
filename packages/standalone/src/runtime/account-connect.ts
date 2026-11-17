/**
 * Connecting a person's own account in their Telegram DM (approvals.md, P2; owner, 2026-11-17:
 * entered in Telegram, which works on a phone). The host asks in that DM with a reply prompt; the
 * person's next message there, within 15 minutes, is the token. The gateway hands that message to
 * the host before anything records it, so it never reaches a turn, the conversation or a trace.
 * The host deletes it from the chat, checks it with the service and stores it (account-store).
 * The token passes Telegram's servers, as every bot message does.
 */
import type { AccountService, AccountStore } from './account-store.js';

export const CONNECT_WINDOW_MS = 15 * 60_000;

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
  now?: () => number;
}

export interface AccountReply {
  chatId: string;
  principalId: string;
  messageId: number;
  text: string;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAccountConnect(ports: AccountConnectPorts) {
  const now = ports.now ?? Date.now;
  /** One waiting prompt per DM: the latest ask wins. */
  const waiting = new Map<
    string,
    { principalId: string; service: AccountService; expiresAt: number }
  >();

  const complete = async (reply: AccountReply, service: AccountService) => {
    const name = SERVICE_NAMES[service];
    let note = '';
    try {
      await ports.deleteMessage(reply.chatId, reply.messageId);
    } catch (error) {
      ports.log(`account ${service} token message delete failed: ${reason(error)}`);
      note = ' I could not delete your message: delete it yourself.';
    }
    const token = reply.text.trim();
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
      await ports.prompt(
        chatId,
        `Reply to this message with ${HOW_TO[service]}. Send it within 15 minutes, as your next message here. The host reads it, deletes it from this chat and stores it; it never reaches the agent or the conversation.`
      );
      waiting.set(chatId, { principalId, service, expiresAt });
      return { expiresAt };
    },

    /**
     * The gateway's check for every DM message, before it is recorded: the completion when this is
     * the awaited token, else null (the message goes on as usual). Taken once.
     */
    claim(reply: AccountReply): (() => Promise<void>) | null {
      const pending = waiting.get(reply.chatId);
      if (!pending || pending.principalId !== reply.principalId) return null;
      waiting.delete(reply.chatId);
      if (now() > pending.expiresAt) return null;
      return () => complete(reply, pending.service);
    },
  };
}

export type AccountConnect = ReturnType<typeof createAccountConnect>;
