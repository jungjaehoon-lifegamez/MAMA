/**
 * A person's own send accounts (approvals.md, P1, P2), managed from that person's DM. connect asks
 * the host to prompt for the token in the DM; the token is the person's reply, which the host takes
 * before any turn sees it, so no input here ever carries one. The common session posts with the
 * install's accounts (auth.env), which are set on the machine.
 */
import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';

import {
  PERSONAL_ACCOUNT_SERVICES,
  SEND_SERVICES,
  type AccountService,
  type AccountStore,
} from '../runtime/account-store.js';

export interface AccountActionPorts {
  ownerPrincipalId: string;
  accounts: AccountStore;
  /** Prompts for the token in the person's own DM. */
  ask(principalId: string, service: AccountService): Promise<{ expiresAt: number }>;
  /** Stops a source collecting on a credential being removed (#final review I1). */
  stopCollecting(principalId: string, service: AccountService): Promise<void>;
}

function person(context: ActionContext, ports: AccountActionPorts): string {
  if (context.access.principalId !== ports.ownerPrincipalId) return context.access.principalId;
  throw Object.assign(
    new Error(
      'The common group posts with the install’s accounts, which are set on the machine (mama secret set). A person connects their own account from their DM.'
    ),
    { name: 'account_common_session', code: 'denied' }
  );
}

const service = (kinds: readonly string[]) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['service'],
    properties: { service: { type: 'string', enum: [...kinds] } },
  }) as const;

export function accountActionRegistrations(ports: AccountActionPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'account.connect',
        summary:
          'Connect your own Chatwork or Slack account, so messages you approve from your DM post as you. The host asks you in this DM for the token as a reply; it is taken before the conversation and never reaches the agent. Never ask for the token in the conversation.',
        inputSchema: service(SEND_SERVICES),
        examples: [{ title: 'Connect Chatwork', input: { service: 'chatwork' } }],
      },
      exec: async (input, context) => {
        const { expiresAt } = await ports.ask(
          person(context, ports),
          (input as { service: AccountService }).service
        );
        return {
          asked: true,
          expiresAt: new Date(expiresAt).toISOString(),
          next: 'The host asked for the token in this DM. The person replies to that message within 15 minutes; the host says when it is connected.',
        };
      },
    },
    {
      contract: {
        name: 'account.disconnect',
        summary:
          'Remove one of your own credentials from MAMA (any kind you connected, for sending or as a source). A source collecting on it stops; source.disconnect also deletes what it collected.',
        inputSchema: service(PERSONAL_ACCOUNT_SERVICES),
      },
      exec: async (input, context) => {
        const principalId = person(context, ports);
        const kind = (input as { service: AccountService }).service;
        // The collector holds a copy of the credential: it stops before the credential goes.
        await ports.stopCollecting(principalId, kind);
        return { removed: ports.accounts.remove(principalId, kind) };
      },
    },
    {
      contract: {
        name: 'account.list',
        summary: 'Your own connected accounts: service, account id, name and when connected.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      },
      exec: (_input, context) => ({ accounts: ports.accounts.list(person(context, ports)) }),
    },
  ];
}
