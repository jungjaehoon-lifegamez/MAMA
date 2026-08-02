import { afterEach, describe, expect, it } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentContext } from '../../src/agent/types.js';
import {
  seedLifecycleCandidateAttempt,
  type SeededExternalLifecycleAttempt,
} from './external-lifecycle-fixtures.js';

const operatorContext: AgentContext = {
  source: 'viewer',
  platform: 'viewer',
  roleName: 'owner_console',
  role: {
    allowedTools: ['*'],
    systemControl: true,
    sensitiveAccess: true,
  },
  session: { sessionId: 'terminal-lifecycle-guard', startedAt: new Date() },
  capabilities: ['All tools'],
  limitations: [],
};

describe('Story EL4: terminal board attempts retain lifecycle guard context (TG-01/TG-06)', () => {
  const databases: SeededExternalLifecycleAttempt[] = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop()!.db.close();
  });

  function terminalFixture(terminal: 'completed' | 'failed') {
    const seeded = seedLifecycleCandidateAttempt();
    databases.push(seeded);
    if (seeded.candidate.kind !== 'lifecycle') throw new Error('lifecycle fixture required');
    if (terminal === 'completed') {
      seeded.ledger.completeWorkOrder(seeded.attempt.id);
    } else {
      seeded.ledger.failWorkOrder(seeded.attempt.id, 'worker failed after tool dispatch');
    }
    const executor = new GatewayToolExecutor({ envelopeIssuanceMode: 'off' });
    executor.setTaskLedger(seeded.ledger);
    const context = {
      agentContext: operatorContext,
      source: 'operator',
      channelId: 'kagemusha:room-b',
      workorderAttemptId: seeded.attempt.id,
      causeEventIds: [seeded.candidate.eventId],
    } as const;
    return { seeded, executor, context };
  }

  it.each(['completed', 'failed'] as const)(
    'rejects late direct candidate status/latest_event writes from a %s attempt',
    async (terminal) => {
      const { seeded, executor, context } = terminalFixture(terminal);
      for (const patch of [{ status: 'done' }, { latest_event: 'late direct write' }]) {
        await expect(
          executor.execute('task_update', { id: seeded.candidate.taskId, ...patch }, context)
        ).rejects.toThrow(/candidate-bound lifecycle/i);
      }
      expect(seeded.ledger.getById(seeded.candidate.taskId)?.revision).toBe(
        seeded.candidate.taskRevision
      );
      await expect(
        executor.execute(
          'task_update',
          { id: seeded.candidate.taskId, title: 'late title', priority: 'high' },
          context
        )
      ).resolves.toMatchObject({ success: true, task: { title: 'late title', priority: 'high' } });
      const unrelated = seeded.ledger.create({ title: 'unrelated native task' });
      await expect(
        executor.execute('task_update', { id: unrelated.id, status: 'done' }, context)
      ).resolves.toMatchObject({ success: true, task: { status: 'done' } });
    }
  );

  it.each(['completed', 'failed'] as const)(
    'rejects late nested candidate writes from a %s attempt',
    async (terminal) => {
      const { seeded, executor, context } = terminalFixture(terminal);
      const result = await executor.execute(
        'code_act',
        {
          code: `task_update({ id: ${seeded.candidate.taskId}, status: 'done' });`,
          allowedTools: ['task_update'],
        },
        context
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringMatching(/candidate-bound lifecycle/i),
      });
      expect(seeded.ledger.getById(seeded.candidate.taskId)?.revision).toBe(
        seeded.candidate.taskRevision
      );
    }
  );
});
