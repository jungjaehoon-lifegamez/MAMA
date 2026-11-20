/**
 * A person's own sources, managed from their own DM (personal-connectors.md, C2). connect asks the
 * host to prompt for the credential in the DM (P2: the reply never reaches a turn); channels lists
 * what that credential reads; bind records the person's pick and starts collecting; disconnect stops
 * it and deletes what it collected. The common session's sources are the install's (connectors.json).
 */
import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';

import type { AccountStore } from '../runtime/account-store.js';
import {
  PERSONAL_SOURCE_KINDS,
  type PersonalChannel,
  type PersonalSourceKind,
  type PersonalSourceStore,
} from '../runtime/personal-source-store.js';

export interface PersonalSourceActionPorts {
  ownerPrincipalId: string;
  store: PersonalSourceStore;
  accounts: AccountStore;
  /** What a credential can read (the kind adapter's list). */
  channels(kind: PersonalSourceKind, secrets: Record<string, string>): Promise<PersonalChannel[]>;
  /** Prompts for the credential in the person's own DM. */
  ask(principalId: string, kind: PersonalSourceKind): Promise<{ expiresAt: number }>;
  /** The running collectors; null until the daemon has started them. */
  sources(): {
    start(principalId: string, kind: PersonalSourceKind): Promise<void>;
    stop(principalId: string, kind: PersonalSourceKind): Promise<void>;
  } | null;
  /** Deletes what a source collected: its raw items and index rows. */
  deleteData(principalId: string, kind: PersonalSourceKind): void;
}

function failure(name: string, message: string, code: 'denied' | 'invalid_input'): Error {
  return Object.assign(new Error(message), { name, code });
}

function person(context: ActionContext, ports: PersonalSourceActionPorts): string {
  if (context.access.principalId !== ports.ownerPrincipalId) return context.access.principalId;
  throw failure(
    'personal_source_common_session',
    'The common group collects the install’s sources, set on the machine (connectors.json). A person connects their own sources from their DM.',
    'denied'
  );
}

const connector = { type: 'string', enum: [...PERSONAL_SOURCE_KINDS] } as const;

function running(ports: PersonalSourceActionPorts) {
  const sources = ports.sources();
  if (!sources) throw new Error('Personal sources are not running yet; try again in a minute.');
  return sources;
}

async function readable(
  ports: PersonalSourceActionPorts,
  principalId: string,
  kind: PersonalSourceKind
): Promise<PersonalChannel[]> {
  const account = ports.accounts.get(principalId, kind);
  if (!account)
    throw failure(
      'account_not_connected',
      `Your ${kind} account is not connected. Connect it with source.connect ${kind}: you reply to the host's message with the credential, and it never passes through the conversation.`,
      'denied'
    );
  return ports.channels(kind, { ...(account.fields ?? {}), token: account.token });
}

export function personalSourceActionRegistrations(
  ports: PersonalSourceActionPorts
): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'source.connect',
        summary:
          'Connect one of your own sources (chatwork, slack, discord, notion, trello, telegram, ical) so MAMA collects it for you only. The host asks you in this DM for the credential as a reply; it never reaches the agent. Never ask for a token in the conversation. Once the host says it is connected, list what it reads with source.channels.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['connector'],
          properties: { connector },
        },
        examples: [{ title: 'Connect Discord', input: { connector: 'discord' } }],
      },
      exec: async (input, context) => {
        const kind = (input as { connector: PersonalSourceKind }).connector;
        const { expiresAt } = await ports.ask(person(context, ports), kind);
        return {
          asked: true,
          expiresAt: new Date(expiresAt).toISOString(),
          next: 'The host asked for the credential in this DM. Once the person says it is connected, call source.channels and ask which to collect.',
        };
      },
    },
    {
      contract: {
        name: 'source.channels',
        summary:
          'The rooms, channels, servers, boards or pages your connected credential can read, with ids, for source.bind. Nothing is collected until you bind some.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['connector'],
          properties: { connector },
        },
      },
      exec: async (input, context) => {
        const kind = (input as { connector: PersonalSourceKind }).connector;
        return { channels: await readable(ports, person(context, ports), kind) };
      },
    },
    {
      contract: {
        name: 'source.bind',
        summary:
          'Collect these channels of your connected source for you only (ids from source.channels; replaces an earlier pick). The first collection reads 7 days back. Then agree with the person how often and when they want it reported, and create that personal job.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['connector', 'channels'],
          properties: {
            connector,
            channels: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          },
        },
      },
      exec: async (input, context) => {
        const values = input as { connector: PersonalSourceKind; channels: string[] };
        const principalId = person(context, ports);
        const available = await readable(ports, principalId, values.connector);
        const unknown = values.channels.filter((id) => !available.some((c) => c.id === id));
        if (unknown.length > 0)
          throw failure(
            'personal_source_channel_unknown',
            `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not readable with this credential; list them with source.channels.`,
            'invalid_input'
          );
        const bound = available.filter((channel) => values.channels.includes(channel.id));
        ports.store.bind(principalId, values.connector, bound);
        await running(ports).start(principalId, values.connector);
        return {
          bound,
          next: 'Agree with the person how often and when they want this source reported, then create that personal job (schedule.job.create).',
        };
      },
    },
    {
      contract: {
        name: 'source.disconnect',
        summary:
          'Stop collecting one of your own sources and delete everything collected from it. The account stays connected for sending until account.disconnect.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['connector'],
          properties: { connector },
        },
      },
      exec: async (input, context) => {
        const kind = (input as { connector: PersonalSourceKind }).connector;
        const principalId = person(context, ports);
        // Stopped first: a poll in flight must not land after the delete.
        await running(ports).stop(principalId, kind);
        ports.deleteData(principalId, kind);
        return { disconnected: ports.store.remove(principalId, kind) };
      },
    },
    {
      contract: {
        name: 'source.list',
        summary:
          'Your own connected sources: the channels collected, the last collection and its error.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      },
      exec: (_input, context) => ({
        sources: ports.store.list(person(context, ports)).map((source) => ({
          connector: source.kind,
          channels: source.channels,
          lastPollAt: source.lastPollAt === null ? null : new Date(source.lastPollAt).toISOString(),
          lastError: source.lastError,
        })),
      }),
    },
  ];
}
