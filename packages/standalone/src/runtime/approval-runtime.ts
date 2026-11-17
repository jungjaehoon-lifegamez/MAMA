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
import { escapeTelegramHtml } from '../gateways/telegram-format.js';

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
  log(line: string): void;
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

/** What a decided proposal's card says under it, from the stored row; null while undecided. */
function outcomeLine(proposal: Proposal): string | null {
  const result = proposal.result as { error?: string } | null;
  const by = proposal.decidedBy ?? 'unknown';
  switch (proposal.status) {
    case 'done':
      return `Done: approved by ${by}. ${summary(proposal.result)}`;
    case 'failed':
      return `Failed: approved by ${by}. ${result?.error ?? 'failed'}`;
    case 'rejected':
      return `Rejected: by ${by}.`;
    case 'expired':
      return 'Expired: nobody decided it within 24 hours.';
    case 'unknown':
      return `Unknown: whether it happened is not known (${result?.error ?? 'no answer'}). Check before asking again.`;
    default:
      return null;
  }
}

export function createApprovalRuntime(ports: ApprovalRuntimePorts) {
  const { store } = ports;
  /** The conversation's note never decides the card: the outcome is stored either way. */
  const note = (proposal: Proposal, line: string) => {
    try {
      ports.record(proposal, line);
    } catch (error) {
      ports.log(
        `approval ${proposal.id} outcome note failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  const finished = (proposal: Proposal, line: string): string => {
    note(proposal, line);
    // The outcome carries text from the input and the service (a title, an error): shown, never markup.
    return `${ports.cardFor(proposal)}\n\n${escapeTelegramHtml(line)}`;
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
      // The call threw after it started: the write may have happened (a receipt that failed after
      // the service answered), so its outcome is unknown, never a failure to retry.
      result = {
        status: 'unknown',
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
    // An unknown outcome may have written: it is never shown as a failure to retry.
    const unknown = result.status === 'unknown';
    const settled = store.finish(proposal.id, { ok: false, error: message, unknown });
    return finished(
      settled,
      unknown
        ? `Unknown: ${by}; whether it happened is not known (${message}). Check before asking again.`
        : `Failed: ${by}. ${message}`
    );
  };

  /**
   * A card no press started (sweep, recovery) may be gone: the owner deleted it, or Telegram
   * refuses the edit. The row's outcome stands either way, so one card never stops the rest.
   */
  const deliver = async (proposal: Proposal, line: string) => {
    const failed = (what: string, error: unknown) =>
      ports.log(
        `approval ${proposal.id} ${what} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    // The note and the card are delivered apart: one failing never skips the other.
    note(proposal, line);
    try {
      await ports.editCard(proposal, `${ports.cardFor(proposal)}\n\n${escapeTelegramHtml(line)}`);
    } catch (error) {
      failed('card edit', error);
    }
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
        if (error instanceof ApprovalRefusedError) {
          // A decided card whose edit was lost is repaired from the stored outcome; nothing runs.
          const settled = store.get(id);
          const line = settled ? outcomeLine(settled) : null;
          return line === null
            ? { answer: refusal(error.reason) }
            : {
                answer: refusal(error.reason),
                card: `${ports.cardFor(settled!)}\n\n${escapeTelegramHtml(line)}`,
              };
        }
        throw error;
      }
      if (decided.status === 'rejected')
        return { answer: 'Rejected', card: finished(decided, `Rejected: by ${decider}.`) };
      return { answer: 'Approved', card: await run(decided) };
    },

    /** Proposals past their expiry: each card says so once. */
    async sweep(): Promise<void> {
      for (const proposal of store.expireDue())
        await deliver(proposal, 'Expired: nobody decided it within 24 hours.');
    },

    /**
     * At boot, nothing runs: a write that was running when the daemon stopped is unknown, and an
     * approved one that never started is failed and proposed again (a boot may be an update
     * candidate, which runs nothing until confirmed).
     */
    async recover(): Promise<void> {
      for (const proposal of store.markInterrupted())
        await deliver(
          proposal,
          'Unknown: the daemon restarted while this ran, so whether it happened is not known. Check before asking again.'
        );
      for (const proposal of store.failNotStarted())
        await deliver(proposal, `Failed: ${(proposal.result as { error: string }).error}`);
    },
  };
}

export type ApprovalRuntime = ReturnType<typeof createApprovalRuntime>;

/**
 * The hourly expiry sweep (A8). One sweep at a time: a tick while one runs is skipped, so
 * `settled` waits for the only sweep that can be recording outcomes and editing cards.
 */
export function scheduleApprovalSweeps(
  sweep: () => Promise<void>,
  options: { intervalMs: number; onError(error: unknown): void }
): { cancel(): void; settled(): Promise<void> } {
  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = sweep()
      .catch(options.onError)
      .finally(() => {
        running = null;
      });
  }, options.intervalMs);
  timer.unref();
  return {
    cancel: () => clearInterval(timer),
    settled: async () => {
      await running;
    },
  };
}
