/**
 * chatwork.message.send and slack.message.send — a message posted in a room or channel the source
 * reads, only after an owner approves its card (docs/development/work/approvals.md, S1 and S2).
 * Both are `approval: 'always'`: core refuses a direct call, an owner's own turn included. From the
 * common session a post goes as the install's account (a Chatwork user, the Slack bot), whose token
 * stays in the running connector; from a person's DM, as that person's own connected account (P1),
 * never the install's. The card names the account, the row keeps its id, and the run posts only
 * while the same account holds the credential.
 */
import type { ActionRegistration } from '@jungjaehoon/mama-core';

import { ChatworkConnector } from '../connectors/chatwork/index.js';
import type { ConnectorRegistry } from '../connectors/framework/connector-registry.js';
import { SlackConnector } from '../connectors/slack/index.js';
import type { ApprovalActionPorts } from './approval-actions.js';
import type { AccountService, AccountStore } from '../runtime/account-store.js';

export const CHATWORK_MESSAGE_SEND_ACTION = 'chatwork.message.send';
export const SLACK_MESSAGE_SEND_ACTION = 'slack.message.send';

export interface MessageSendPorts {
  connectors?: () => ConnectorRegistry | null;
  /** The common session's principal: it posts with the install's accounts. */
  ownerPrincipalId: string;
  accounts: AccountStore;
  /** The account an approved proposal's card named (its row). */
  proposalAccount(proposalId: string): string | null;
}

const SERVICE_NAMES: Partial<Record<AccountService, string>> = {
  chatwork: 'Chatwork',
  slack: 'Slack',
};

/**
 * The token a principal posts with: undefined for the common session (the connector's own), the
 * person's connected one otherwise. A person without one is refused: nobody's write runs on
 * another's account.
 */
function tokenFor(
  ports: MessageSendPorts,
  principalId: string,
  service: AccountService
): string | undefined {
  if (principalId === ports.ownerPrincipalId) return undefined;
  const account = ports.accounts.get(principalId, service);
  if (account) return account.token;
  throw failure(
    'account_not_connected',
    `Your ${SERVICE_NAMES[service]} account is not connected, and a DM's message posts as you. Connect it with account.connect ${service}: you reply to the host's message with your token, and it never passes through the conversation.`
  );
}

/** Posts only while the account the card named holds the credential (P1). */
async function sameAccount(
  ports: MessageSendPorts,
  proposalId: string | undefined,
  current: () => Promise<{ id: string }>,
  service: AccountService
): Promise<void> {
  const named = proposalId === undefined ? null : ports.proposalAccount(proposalId);
  const now = (await current()).id;
  if (named === null)
    throw failure(
      'account_changed',
      'This card was proposed before cards recorded the account they post as. It was not posted: propose it again.'
    );
  if (named !== now)
    throw failure(
      'account_changed',
      `The ${SERVICE_NAMES[service]} credential now posts as account ${now}, but the card named ${String(named)}. It was not posted: propose it again.`
    );
}

function failure(name: string, message: string, code?: 'invalid_input'): Error {
  return Object.assign(new Error(message), { name, ...(code === undefined ? {} : { code }) });
}

function named(place: { id: string; name: string | null }): string {
  return place.name === null ? place.id : `${place.id} (${place.name})`;
}

function chatwork(ports: MessageSendPorts): ChatworkConnector {
  const connector = ports.connectors?.()?.get('chatwork');
  if (!(connector instanceof ChatworkConnector))
    throw failure('chatwork_not_running', 'The Chatwork source is not running.');
  return connector;
}

function slack(ports: MessageSendPorts): SlackConnector {
  const connector = ports.connectors?.()?.get('slack');
  if (!(connector instanceof SlackConnector))
    throw failure('slack_not_running', 'The Slack source is not running.');
  return connector;
}

/** The room, which must be one the source reads (S1): a send never reaches a room MAMA does not read. */
function chatworkRoom(connector: ChatworkConnector, roomId: string) {
  const rooms = connector.rooms();
  const room = rooms.find((candidate) => candidate.id === roomId);
  if (!room)
    throw failure(
      'chatwork_room_not_read',
      `${roomId} is not a room the Chatwork source reads; the rooms are: ${rooms.map(named).join(', ')}.`,
      'invalid_input'
    );
  return room;
}

function slackChannel(connector: SlackConnector, channelId: string) {
  const channels = connector.channels();
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel)
    throw failure(
      'slack_channel_not_read',
      `${channelId} is not a channel the Slack source reads; the channels are: ${channels.map(named).join(', ')}.`,
      'invalid_input'
    );
  return channel;
}

interface ChatworkSend {
  roomId: string;
  body: string;
}

interface SlackSend {
  channel: string;
  text: string;
  threadTs?: string;
}

export function messageSendActionRegistrations(ports: MessageSendPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: CHATWORK_MESSAGE_SEND_ACTION,
        readsConnector: { fixed: 'chatwork' },
        approval: 'always',
        summary:
          'Post a message in a Chatwork room the Chatwork source reads, as the install’s Chatwork account from the common group, as your own connected account from your DM. Runs only after an owner approves it: propose it with approval.propose. roomId is the room’s id (the room key source.search and source.read show); body is the whole message as it will be posted. Returns the room and the posted message id.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['roomId', 'body'],
          properties: {
            roomId: { type: 'string', pattern: '^[0-9]+$' },
            body: { type: 'string', minLength: 1 },
          },
        },
        examples: [
          {
            title: 'Answer in a room',
            input: { roomId: '123456789', body: 'Thank you, the estimate follows tomorrow.' },
          },
        ],
      },
      exec: async (input, context) => {
        const values = input as ChatworkSend;
        const connector = chatwork(ports);
        const room = chatworkRoom(connector, values.roomId);
        const token = tokenFor(ports, context.access.principalId, 'chatwork');
        await sameAccount(
          ports,
          context.session?.approvedProposalId,
          () => connector.account(token),
          'chatwork'
        );
        const posted = await connector.sendMessage(room.id, values.body, token);
        return { roomId: room.id, room: room.name, messageId: posted.messageId };
      },
    },
    {
      contract: {
        name: SLACK_MESSAGE_SEND_ACTION,
        readsConnector: { fixed: 'slack' },
        approval: 'always',
        summary:
          'Post a message in a Slack channel the Slack source reads, as the install’s Slack bot from the common group, as your own connected account from your DM. Runs only after an owner approves it: propose it with approval.propose. channel is the channel id; threadTs, the ts of the message to reply under; text is the whole message as it will be posted. Returns the channel and the posted message ts.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['channel', 'text'],
          properties: {
            channel: { type: 'string', pattern: '^[A-Z0-9]+$' },
            text: { type: 'string', minLength: 1 },
            threadTs: { type: 'string', pattern: '^[0-9]+\\.[0-9]+$' },
          },
        },
        examples: [
          {
            title: 'Reply in a thread',
            input: {
              channel: 'C0123456789',
              text: 'Done, see the board.',
              threadTs: '1700000000.000100',
            },
          },
        ],
      },
      exec: async (input, context) => {
        const values = input as SlackSend;
        const connector = slack(ports);
        const channel = slackChannel(connector, values.channel);
        const token = tokenFor(ports, context.access.principalId, 'slack');
        await sameAccount(
          ports,
          context.session?.approvedProposalId,
          () => connector.account(token),
          'slack'
        );
        const posted = await connector.postMessage(channel.id, values.text, values.threadTs, token);
        return { channel: posted.channel, name: channel.name, ts: posted.ts };
      },
    },
  ];
}

/**
 * The cards: the message as it will be posted, and, read when it is proposed, the room by name and
 * the account it posts as. A room the source does not read fails the proposal.
 */
export function messageSendCards(ports: MessageSendPorts): ApprovalActionPorts['cards'] {
  return {
    [CHATWORK_MESSAGE_SEND_ACTION]: {
      title: 'Chatwork: post message',
      render: (input) => {
        const values = input as ChatworkSend;
        return ['Action: post a message in Chatwork', `Message: ${values.body}`];
      },
      personal: true,
      account: async (proposer) => {
        const token = tokenFor(ports, proposer ?? ports.ownerPrincipalId, 'chatwork');
        const account = await chatwork(ports).account(token);
        return {
          id: account.id,
          line: `Posts as: ${account.name} (${proposer === null ? 'the install’s' : 'your own'} Chatwork account ${account.id})`,
        };
      },
      context: async (input) => {
        const values = input as ChatworkSend;
        const room = chatworkRoom(chatwork(ports), values.roomId);
        return [`Room: ${room.name ?? '(no name)'} (${room.id})`];
      },
    },
    [SLACK_MESSAGE_SEND_ACTION]: {
      title: 'Slack: post message',
      render: (input) => {
        const values = input as SlackSend;
        return [
          'Action: post a message in Slack',
          ...(values.threadTs === undefined ? [] : [`In thread: ${values.threadTs}`]),
          `Message: ${values.text}`,
        ];
      },
      personal: true,
      account: async (proposer) => {
        const token = tokenFor(ports, proposer ?? ports.ownerPrincipalId, 'slack');
        const account = await slack(ports).account(token);
        return {
          id: account.id,
          line: `Posts as: ${account.name} (${account.bot ? 'the bot' : proposer === null ? 'the install’s account' : 'your own account'})`,
        };
      },
      context: async (input) => {
        const values = input as SlackSend;
        const channel = slackChannel(slack(ports), values.channel);
        return [`Channel: #${channel.name ?? '(no name)'} (${channel.id})`];
      },
    },
  };
}
