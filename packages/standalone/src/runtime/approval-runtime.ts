/**
 * Deciding and running proposals (approvals.md, A5–A8). A card's button reaches `press`, never a
 * turn. The host checks who pressed, the nonce and the expiry (in the store), then runs the stored
 * action with the stored input, once, under the proposing session's access, stating the approval
 * as a session fact. The card and the conversation get one line for every outcome.
 */
import type {
  ActionCall,
  ActionContext,
  ActionResult,
  JudgmentAccess,
} from '@jungjaehoon/mama-core';
import { ApprovalRefusedError, type ApprovalStore, type Proposal } from './approval-store.js';

export interface ApprovalRuntimePorts {
  store: ApprovalStore;
  dispatch(call: ActionCall, context: ActionContext): Promise<ActionResult>;
  /** The proposing session's access: the common session's for null, else that person's. */
  accessFor(principalId: string | null): JudgmentAccess;
  /** The registered person who pressed, or null for anyone else. */
  deciderFor(chatId: string, userId: string): string | null;
  mayDecide(proposal: Proposal, deciderPrincipalId: string): boolean;
  /** The card as it was sent, from the stored proposal. */
  cardFor(proposal: Proposal): string;
  /** The conversation keeps the proposal's outcome. */
  record(proposal: Proposal, line: string): void;
  /** Replace the card's text and remove its buttons (sweep and recovery, which no press started). */
  editCard(proposal: Proposal, card: string): Promise<void>;
  now?: () => number;
}

export interface ApprovalPress {
  data: string;
  chatId: string;
  userId: string;
  messageId: number;
}

const REFUSALS: Record<string, string> = {
  wrong_nonce: 'This button is not valid.',
  expired: 'Expired',
  unknown_proposal: 'Unknown proposal',
};

function refusal(reason: string): string {
  if (reason.startsWith('already_')) {
    const status = reason.slice('already_'.length);
    // Every status past approval reads as approved to the person pressing.
    return status === 'rejected' || status === 'expired' ? `Already ${status}` : 'Already approved';
  }
  return REFUSALS[reason] ?? reason;
}

function summary(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function createApprovalRuntime(ports: ApprovalRuntimePorts) {
  const { store } = ports;
  const finished = (proposal: Proposal, line: string): string => {
    ports.record(proposal, line);
    return `${ports.cardFor(proposal)}\n\n${line}`;
  };

  const run = async (approved: Proposal): Promise<string> => {
    const proposal = store.beginExecution(approved.id);
    let result: ActionResult;
    try {
      result = await ports.dispatch(
        { action: proposal.action, input: proposal.input, operationId: proposal.id },
        {
          access: ports.accessFor(proposal.principalId),
          session: { approvedProposalId: proposal.id },
        }
      );
    } catch (error) {
      result = {
        status: 'failed',
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : String(error),
        },
      } as ActionResult;
    }
    const by = `approved by ${proposal.decidedBy ?? 'unknown'}`;
    if (result.status === 'completed') {
      const done = store.finish(proposal.id, { ok: true, result: result.data });
      return finished(done, `Done: ${by}. ${summary(result.data)}`);
    }
    const message = (result as { error?: { message?: string } }).error?.message ?? 'failed';
    const failed = store.finish(proposal.id, { ok: false, error: message });
    return finished(failed, `Failed: ${by}. ${message}`);
  };

  return {
    async press(input: ApprovalPress): Promise<{ answer: string; card?: string }> {
      const match = /^apv:([ar]):([^:]+):([A-Za-z0-9_-]+)$/.exec(input.data);
      if (!match) return { answer: 'This button is not valid.' };
      const [, kind, id, nonce] = match as unknown as [string, 'a' | 'r', string, string];
      const proposal = store.get(id);
      if (!proposal) return { answer: 'Unknown proposal' };
      const decider = ports.deciderFor(input.chatId, input.userId);
      if (decider === null || !ports.mayDecide(proposal, decider))
        return { answer: 'You may not decide this proposal.' };
      let decided: Proposal;
      try {
        decided = store.decide(id, kind === 'a' ? 'approve' : 'reject', {
          nonce,
          deciderPrincipalId: decider,
        });
      } catch (error) {
        if (error instanceof ApprovalRefusedError) return { answer: refusal(error.reason) };
        throw error;
      }
      if (decided.status === 'rejected')
        return { answer: 'Rejected', card: finished(decided, `Rejected: by ${decider}.`) };
      return { answer: 'Approved', card: await run(decided) };
    },

    /** Proposals past their expiry: each card says so once. */
    async sweep(): Promise<void> {
      for (const proposal of store.expireDue()) {
        const card = finished(proposal, 'Expired: nobody decided it within 24 hours.');
        await ports.editCard(proposal, card);
      }
    },

    /**
     * At boot: a write that was running when the daemon stopped is unknown and never run again;
     * an approved one that never started runs now, once.
     */
    async recover(): Promise<void> {
      for (const proposal of store.markInterrupted()) {
        const card = finished(
          proposal,
          'Unknown: the daemon restarted while this ran, so whether it happened is not known. Check before asking again.'
        );
        await ports.editCard(proposal, card);
      }
      for (const proposal of store.approvedNotStarted()) {
        await ports.editCard(proposal, await run(proposal));
      }
    },
  };
}

export type ApprovalRuntime = ReturnType<typeof createApprovalRuntime>;
