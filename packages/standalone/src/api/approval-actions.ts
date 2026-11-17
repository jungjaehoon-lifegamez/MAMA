/**
 * approval.propose — the agent asks for a write it may not run alone (approvals.md, A3, A5). The
 * host checks that the proposer may call the action and that the input is one the action takes,
 * stores it, and sends the owner a card rendered from the stored input. Deciding is the owner's,
 * by the card's buttons; nothing here runs the write.
 */
import type { ActionCatalog, ActionRegistration } from '@jungjaehoon/mama-core';
import { validateInput } from '@jungjaehoon/mama-core/api/dispatch';
import { ApprovalConflictError, type ApprovalStore } from '../runtime/approval-store.js';
import { renderApprovalCard, type ApprovalCardRenderer } from '../runtime/approval-cards.js';

export const APPROVAL_PROPOSE_ACTION = 'approval.propose';

/** Telegram refuses callback data over 64 bytes. */
const CALLBACK_DATA_MAX_BYTES = 64;

export interface ApprovalActionPorts {
  store: ApprovalStore;
  catalog: Pick<ActionCatalog, 'entry'>;
  /** The common session's principal: its proposals are the common session's (principalId null). */
  ownerPrincipalId: string;
  cards: Readonly<
    Record<
      string,
      {
        title: string;
        render: ApprovalCardRenderer;
        /**
         * What the write would change, read when it is proposed (a delete's event title and time).
         * A failure refuses the proposal: a card must not name something that is not there.
         */
        context?: (input: unknown) => Promise<string[]>;
      }
    >
  >;
  /** Where the card goes: the common channel for null, else that person's DM. */
  sendCard(
    target: { principalId: string | null },
    html: string,
    buttons: { approve: string; reject: string }
  ): Promise<{ chatId: string; messageId: number }>;
  timeZone(): string;
}

function failure(name: string, message: string, code: 'invalid_input' | 'denied'): Error {
  return Object.assign(new Error(message), { name, code });
}

export function approvalActionRegistrations(ports: ApprovalActionPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: APPROVAL_PROPOSE_ACTION,
        summary:
          'Propose a write that runs only after an owner approves it in Telegram: action is the write (google.calendar.write, …) and input exactly what it takes. The host shows the owner a card made from that input and runs it once if approved. requestKey names this proposal within the turn: the same key again returns the same proposal. reason is one line on why, shown on the card. A changed request is a new proposal. Not in a replay.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'input', 'requestKey'],
          properties: {
            action: { type: 'string', minLength: 1 },
            input: { type: 'object' },
            requestKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
            reason: { type: 'string', maxLength: 300 },
          },
        },
        examples: [
          {
            title: 'Book a meeting the source asked for',
            input: {
              action: 'google.calendar.write',
              input: {
                op: 'create',
                meet: true,
                event: {
                  summary: 'Review',
                  start: { dateTime: '2026-11-20T10:30:00', timeZone: 'Asia/Seoul' },
                  end: { dateTime: '2026-11-20T11:00:00', timeZone: 'Asia/Seoul' },
                },
              },
              requestKey: 'review-meeting',
              reason: 'The client asked for a review call on Friday morning',
            },
          },
        ],
      },
      exec: async (input, context) => {
        if (context.session?.replaySourceEndMs !== undefined)
          throw failure(
            'approval_replay',
            'approval.propose is not available in a replay.',
            'denied'
          );
        const values = input as {
          action: string;
          input: object;
          requestKey: string;
          reason?: string;
        };
        let contract;
        try {
          contract = ports.catalog.entry(values.action).contract;
        } catch {
          throw failure(
            'approval_unknown_action',
            `There is no action ${values.action}.`,
            'invalid_input'
          );
        }
        const card = ports.cards[values.action];
        if (contract.approval === undefined || card === undefined)
          throw failure(
            'approval_not_proposable',
            `${values.action} does not take approval: call it directly, if it is yours to call.`,
            'invalid_input'
          );
        if (!context.access.actions?.includes(values.action))
          throw failure(
            'approval_not_granted',
            `This session may not propose ${values.action}.`,
            'denied'
          );
        const invalid = validateInput(contract.inputSchema, values.input, 'input');
        if (invalid !== null) throw failure('approval_invalid_input', invalid, 'invalid_input');
        let current: string[] = [];
        if (card.context)
          try {
            current = await card.context(values.input);
          } catch (error) {
            throw failure(
              'approval_target_unreadable',
              `What ${values.action} would change could not be read: ${error instanceof Error ? error.message : String(error)}`,
              'invalid_input'
            );
          }

        const principalId =
          context.access.principalId === ports.ownerPrincipalId ? null : context.access.principalId;
        let stored;
        try {
          stored = ports.store.propose({
            action: values.action,
            input: values.input,
            principalId,
            modelRunId: context.session?.modelRunId ?? null,
            requestKey: values.requestKey,
            ...(values.reason === undefined ? {} : { reason: values.reason }),
            ...(context.session?.sourceRefs === undefined
              ? {}
              : { sourceRefs: context.session.sourceRefs }),
          });
        } catch (error) {
          if (error instanceof ApprovalConflictError)
            throw failure('approval_request_key_conflict', error.message, 'invalid_input');
          throw error;
        }
        const { proposal, nonce, repeated } = stored;
        if (repeated)
          return {
            proposalId: proposal.id,
            state: proposal.messageId === null ? 'unknown' : 'sent',
            repeated: true,
          };
        const buttons = {
          approve: `apv:a:${proposal.id}:${nonce}`,
          reject: `apv:r:${proposal.id}:${nonce}`,
        };
        if (Buffer.byteLength(buttons.approve) > CALLBACK_DATA_MAX_BYTES)
          throw new Error(`proposal ${proposal.id} is too long for a Telegram button`);
        const html = renderApprovalCard(
          card.title,
          [...card.render(values.input), ...current],
          proposal,
          ports.timeZone()
        );
        ports.store.setCardHtml(proposal.id, html);
        try {
          const sent = await ports.sendCard({ principalId }, html, buttons);
          ports.store.setCard(proposal.id, sent.chatId, sent.messageId);
          return { proposalId: proposal.id, state: 'sent', repeated: false };
        } catch (error) {
          // Whether Telegram showed the card is not known; the agent says so instead of retrying.
          return {
            proposalId: proposal.id,
            state: 'unknown',
            repeated: false,
            note: `The card may not have reached the owner (${error instanceof Error ? error.message : String(error)}). Tell the owner; do not propose it again.`,
          };
        }
      },
    },
  ];
}
