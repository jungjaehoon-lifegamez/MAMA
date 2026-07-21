import { describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import type { AgentLoopOptions } from '../../src/agent/types.js';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { WorkOrderConsumer } from '../../src/operator/workorder-consumer.js';
import { attachWorkOrderAttemptContext } from '../../src/operator/worker-run.js';

describe('Story A1: claimed workorder attempt context', () => {
  it('carries the claimed row id through runOptionsFor and workerRun into AgentLoop context', async () => {
    const db: SQLiteDatabase = new Database(':memory:');
    const ledger = new TaskLedger(db);
    let claimedId: number | undefined;
    let observedAttemptId: number | undefined;
    const consumer = new WorkOrderConsumer({
      ledger,
      runner: {
        runWithContent: async (_content, options) => {
          observedAttemptId = buildAgentToolExecutionContext(
            options as AgentLoopOptions
          )?.workorderAttemptId;
          return { response: 'done' };
        },
      },
      loadBrief: () => 'Execute one synthetic workorder.',
      noticeOwner: () => {},
      opsAlarm: { configured: false, send: async () => {} },
      runOptionsFor: (wo) => {
        claimedId = wo.id;
        return attachWorkOrderAttemptContext({}, wo.id);
      },
      log: () => {},
    });
    const enqueued = ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'attempt-context:board',
      input: { mode: 'full' },
    });

    await consumer.tick();

    expect(claimedId).toBe(enqueued.id);
    expect(observedAttemptId).toBe(enqueued.id);
    db.close();
  });
});
