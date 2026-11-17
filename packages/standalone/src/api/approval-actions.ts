/**
 * approval.propose — the agent asks for a write it may not run alone (approvals.md, A3, A5). The
 * host checks that the proposer may call the action and that the input is one the action takes,
 * stores it, and sends the owner a card rendered from the stored input. Deciding is the owner's,
 * by the card's buttons; nothing here runs the write.
 */
import type { ActionCatalog, ActionRegistration } from '@jungjaehoon/mama-core';
import { validateInput } from '@jungjaehoon/mama-core/api/dispatch';
import {
  APPROVAL_EXPIRY_MS,
  ApprovalConflictError,
  proposalFingerprint,
  type ApprovalStore,
} from '../runtime/approval-store.js';
import {
  cardTextLength,
  renderApprovalCard,
  type ApprovalCardRenderer,
} from '../runtime/approval-cards.js';
import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../gateways/telegram-format.js';

export const APPROVAL_PROPOSE_ACTION = 'approval.propose';

/**
 * The longest card a proposal may have: Telegram's message limit, less room for the result line
 * the card gains when it is decided. A longer card could not be sent, and its proposal could never
 * be approved (#588 review).
 */
const CARD_MAX_LENGTH = TELEGRAM_MAX_MESSAGE_LENGTH - 500;

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
         * `proposer` is the proposing person, null for the common session.
         */
        context?: (input: unknown, proposer: string | null) => Promise<string[]>;
        /**
         * Whether a person's DM may propose it: the write then runs on that person's own
         * connected account (A5, P1). Without it only the common session proposes.
         */
        personal?: boolean;
        /**
         * The account the write posts as: its id is stored on the row and checked again when it
         * runs, and its line goes on the card. An error named `account_not_connected` refuses the
         * proposal with how to connect it.
         */
        account?: (proposer: string | null) => Promise<{ id: string; line: string }>;
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
          'Propose a write that runs only after an owner approves it in Telegram: action is the write (google.calendar.write, chatwork.message.send, slack.message.send) and input exactly what it takes. The host shows the owner a card made from that input and runs it once if approved. requestKey names this proposal within the turn: the same key again returns the same proposal. reason is one line on why, shown on the card. A changed request is a new proposal. Not in a replay.',
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
        // The same connector grant a direct call meets, checked before the target is read for the
        // card: a proposal must not read what the session itself may not.
        const reads = contract.readsConnector;
        const connector =
          reads === undefined
            ? undefined
            : 'fixed' in reads
              ? reads.fixed
              : (values.input as Record<string, unknown>)[reads.fromInput];
        if (
          connector !== undefined &&
          !(context.access.connectors ?? []).includes(String(connector))
        )
          throw failure(
            'connector_out_of_scope',
            `This session may not use the ${String(connector)} connector.`,
            'denied'
          );
        const invalid = validateInput(contract.inputSchema, values.input, 'input');
        if (invalid !== null) throw failure('approval_invalid_input', invalid, 'invalid_input');
        const principalId =
          context.access.principalId === ports.ownerPrincipalId ? null : context.access.principalId;
        // A DM's write runs on that person's own account (approvals.md, A5). An action that cannot
        // run on one yet (Google until G1) is proposed from the common group only.
        if (principalId !== null && !card.personal)
          throw failure(
            'approval_personal_account_missing',
            `${values.action} is proposed from the common group for now: a DM write runs on the person’s own account, and ${values.action} cannot use one yet.`,
            'denied'
          );
        // A repeat answers from what was stored, before anything is read again.
        const earlier = ports.store.find(context.session?.modelRunId ?? null, values.requestKey);
        if (earlier && earlier.fingerprint !== proposalFingerprint(values.action, values.input))
          throw failure(
            'approval_request_key_conflict',
            `request key ${values.requestKey} was already used for a different proposal in this run`,
            'invalid_input'
          );
        if (earlier)
          return {
            proposalId: earlier.id,
            state: earlier.messageId === null ? 'unknown' : 'sent',
            repeated: true,
          };
        let account: { id: string; line: string } | undefined;
        if (card.account)
          try {
            account = await card.account(principalId);
          } catch (error) {
            if (error instanceof Error && error.name === 'account_not_connected')
              throw failure('approval_account_missing', error.message, 'denied');
            throw failure(
              'approval_account_unreadable',
              `The account ${values.action} would post as could not be read: ${error instanceof Error ? error.message : String(error)}`,
              'invalid_input'
            );
          }
        let current: string[] = [];
        if (card.context)
          try {
            current = await card.context(values.input, principalId);
          } catch (error) {
            throw failure(
              'approval_target_unreadable',
              `What ${values.action} would change could not be read: ${error instanceof Error ? error.message : String(error)}`,
              'invalid_input'
            );
          }

        // Measured before anything is stored: the expiry line is the same length either way.
        const lines = [
          ...card.render(values.input),
          ...current,
          ...(account === undefined ? [] : [account.line]),
        ];
        const draft = renderApprovalCard(
          card.title,
          lines,
          {
            reason: values.reason ?? null,
            expiresAt: Date.now() + APPROVAL_EXPIRY_MS,
          },
          ports.timeZone()
        );
        if (cardTextLength(draft) > CARD_MAX_LENGTH)
          throw failure(
            'approval_card_too_long',
            `The card would be ${cardTextLength(draft)} characters; Telegram shows at most ${CARD_MAX_LENGTH} for a card. Shorten it by about ${cardTextLength(draft) - CARD_MAX_LENGTH} characters and propose again.`,
            'invalid_input'
          );

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
            ...(account === undefined ? {} : { accountId: account.id }),
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
        const html = renderApprovalCard(card.title, lines, proposal, ports.timeZone());
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
