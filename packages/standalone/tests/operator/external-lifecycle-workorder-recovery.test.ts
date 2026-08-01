/**
 * TG-01/TG-05/TG-06 Task 6: durable lifecycle receipts, not transport prose,
 * decide candidate-bearing board completion and crash recovery.
 */
import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agent/types.js';
import {
  WorkOrderConsumer,
  type WorkOrderConsumerDeps,
} from '../../src/operator/workorder-consumer.js';
import {
  seedBindingCandidateAttempt,
  seedLifecycleCandidateAttempt,
} from './external-lifecycle-fixtures.js';

function consumerFor(
  ledger: WorkOrderConsumerDeps['ledger'],
  runner: WorkOrderConsumerDeps['runner'],
  overrides: Partial<WorkOrderConsumerDeps> = {}
): WorkOrderConsumer {
  return new WorkOrderConsumer({
    ledger,
    runner,
    loadBrief: () => 'Reconcile the board.',
    noticeOwner: () => {},
    opsAlarm: { configured: false, send: async () => {} },
    log: () => {},
    ...overrides,
  });
}

function makePending(seeded: ReturnType<typeof seedBindingCandidateAttempt>): void {
  seeded.db
    .prepare("UPDATE operator_tasks SET status = 'pending' WHERE id = ?")
    .run(seeded.attempt.id);
}

describe('TG-01/TG-05/TG-06 Task 6: receipt-authoritative board candidate recovery', () => {
  it('completes a full receipted candidate attempt when the runner result is lost', async () => {
    const seeded = seedLifecycleCandidateAttempt();
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
    seeded.ledger.applyExternalLifecycleDecision(
      seeded.attempt.id,
      {
        candidate_id: seeded.candidate.candidateId,
        decision: 'apply',
        reason: 'committed before result loss',
        expected_revision: seeded.candidate.taskRevision,
      },
      {
        runId: 'before-result-loss',
        workOrderAttemptId: seeded.attempt.id,
        causeEventIds: [seeded.candidate.eventId],
      }
    );
    makePending(seeded);
    let runs = 0;
    const consumer = consumerFor(seeded.ledger, {
      runWithContent: async () => {
        runs++;
        throw new Error('transport result lost');
      },
    });

    await consumer.tick();

    expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('done');
    expect(seeded.ledger.countPendingWorkOrders()).toBe(0);
    expect(runs).toBe(1);
  });

  it('fails a partial receipt set loudly without replaying it', async () => {
    const seeded = seedBindingCandidateAttempt({ candidateCount: 2 });
    if (seeded.candidate.kind !== 'binding') throw new Error('binding fixture required');
    seeded.ledger.applyExternalBindingDecision(
      seeded.attempt.id,
      {
        candidate_id: seeded.candidate.candidateId,
        decision: 'bind',
        reason: 'first candidate decided',
        expected_revision: seeded.candidate.taskRevision,
      },
      {
        runId: 'partial-receipt',
        workOrderAttemptId: seeded.attempt.id,
        causeEventIds: [seeded.candidate.eventId],
      }
    );
    makePending(seeded);
    const consumer = consumerFor(seeded.ledger, {
      runWithContent: async () => ({ response: 'runner completed but second decision is missing' }),
    });

    await consumer.tick();

    expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('failed');
    expect(
      seeded.db
        .prepare('SELECT latest_event FROM operator_tasks WHERE id = ?')
        .get(seeded.attempt.id)
    ).toEqual({ latest_event: expect.stringMatching(/partial/i) });
    expect(seeded.ledger.countPendingWorkOrders()).toBe(0);
  });

  it.each(['before_hook_failed', 'run_options_failed'] as const)(
    'creates one candidate-only replacement after a zero-receipt %s failure before the runner',
    async (failure) => {
      const seeded = seedBindingCandidateAttempt();
      makePending(seeded);
      let runs = 0;
      let runOptionsCalls = 0;
      const consumer = consumerFor(
        seeded.ledger,
        { runWithContent: async () => ({ response: (++runs, 'must not run') }) },
        failure === 'before_hook_failed'
          ? { runOptionsFor: () => undefined }
          : {
              runOptionsFor: async () => {
                runOptionsCalls++;
                if (runOptionsCalls === 1) throw new Error('envelope unavailable');
                return undefined;
              },
            }
      );
      if (failure === 'before_hook_failed') {
        consumer.registerHook('board', {
          before: () => Promise.reject(new Error('snapshot unavailable')),
        });
      }

      await consumer.tick();

      expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('failed');
      expect(seeded.ledger.countPendingWorkOrders()).toBe(1);
      await consumer.tick();
      expect(seeded.ledger.countPendingWorkOrders()).toBe(0);
      expect(runs).toBe(failure === 'before_hook_failed' ? 0 : 1);
    }
  );

  it('does not let a runner error string mint retry authority after runWithContent entered', async () => {
    const seeded = seedBindingCandidateAttempt();
    makePending(seeded);
    const consumer = consumerFor(seeded.ledger, {
      runWithContent: async () => Promise.reject(new Error('before_hook_failed')),
    });

    await consumer.tick();

    expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('failed');
    expect(seeded.ledger.countPendingWorkOrders()).toBe(0);
  });

  it.each([
    'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
    'MCP_RESULT_MISSING',
    'MCP_COMPLETED_MUTATION_INTERRUPTED',
  ] as const)(
    'does not replay a zero-receipt candidate after terminal runner evidence %s',
    async (code) => {
      const seeded = seedBindingCandidateAttempt();
      makePending(seeded);
      const consumer = consumerFor(seeded.ledger, {
        runWithContent: async () => Promise.reject(new AgentError('runner entered', code)),
      });

      await consumer.tick();

      expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('failed');
      expect(seeded.ledger.countPendingWorkOrders()).toBe(0);
    }
  );

  it('does not replay a zero-receipt candidate when its required post-run verdict fails', async () => {
    const seeded = seedBindingCandidateAttempt();
    makePending(seeded);
    const consumer = consumerFor(seeded.ledger, {
      runWithContent: async () => ({ response: 'runner entered' }),
    });
    consumer.registerHook('board', {
      verdictRequired: true,
      after: () => ({ disposition: 'fail', reason: 'required receipt verdict failed' }),
    });

    await consumer.tick();

    expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('failed');
    expect(seeded.ledger.countPendingWorkOrders()).toBe(0);
  });

  it('completes a stale claim from a full receipt set without running it again', () => {
    const seeded = seedLifecycleCandidateAttempt();
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
    seeded.ledger.applyExternalLifecycleDecision(
      seeded.attempt.id,
      {
        candidate_id: seeded.candidate.candidateId,
        decision: 'apply',
        reason: 'committed before crash',
        expected_revision: seeded.candidate.taskRevision,
      },
      {
        runId: 'before-crash',
        workOrderAttemptId: seeded.attempt.id,
        causeEventIds: [seeded.candidate.eventId],
      }
    );
    let runs = 0;
    const consumer = consumerFor(seeded.ledger, {
      runWithContent: async () => ({ response: (++runs, 'must not run') }),
    });

    consumer.bootRecover();

    expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('done');
    expect(runs).toBe(0);
  });

  it.each(['partial', 'zero'] as const)('fails a stale %s receipt set without replay', (state) => {
    const seeded = seedBindingCandidateAttempt({ candidateCount: state === 'partial' ? 2 : 1 });
    if (state === 'partial') {
      seeded.ledger.applyExternalBindingDecision(
        seeded.attempt.id,
        {
          candidate_id: seeded.candidate.candidateId,
          decision: 'bind',
          reason: 'only one receipt before crash',
          expected_revision: seeded.candidate.taskRevision,
        },
        {
          runId: 'before-crash',
          workOrderAttemptId: seeded.attempt.id,
          causeEventIds: [seeded.candidate.eventId],
        }
      );
    }
    let runs = 0;
    const consumer = consumerFor(seeded.ledger, {
      runWithContent: async () => ({ response: (++runs, 'must not run') }),
    });

    consumer.bootRecover();

    expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('failed');
    expect(seeded.ledger.countPendingWorkOrders()).toBe(0);
    expect(runs).toBe(0);
  });

  it('establishes a receipt-read claim barrier before it can claim new work', async () => {
    const seeded = seedBindingCandidateAttempt();
    const ordinary = seeded.ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'ordinary-after-unresolved-candidate',
      input: { mode: 'full' },
    });
    const inspect = seeded.ledger.inspectBoardCandidateAttempt.bind(seeded.ledger);
    seeded.ledger.inspectBoardCandidateAttempt = () => {
      throw new Error('receipt database unavailable');
    };
    let runs = 0;
    const consumer = consumerFor(seeded.ledger, {
      runWithContent: async () => ({ response: (++runs, 'must not run') }),
    });

    consumer.bootRecover();
    await consumer.tick();
    seeded.ledger.inspectBoardCandidateAttempt = inspect;

    expect(seeded.ledger.getWorkOrderById(seeded.attempt.id)?.status).toBe('in_progress');
    expect(seeded.ledger.getWorkOrderById(ordinary.id)?.status).toBe('pending');
    expect(runs).toBe(0);
  });
});
