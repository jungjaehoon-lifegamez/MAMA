import { beforeEach, describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { OwnerActionEffectLedger } from '../../src/operator/owner-action-effects.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import {
  OwnerEventLoop,
  closeOwnerEventBeforeDatabase,
} from '../../src/operator/owner-event-loop.js';
import type { AgentContext } from '../../src/agent/types.js';
import type { Envelope } from '../../src/envelope/types.js';

const testEnvelope = {} as Envelope;
const issueTestEnvelope = async () => testEnvelope;

const ownerContext: AgentContext = {
  source: 'owner-event',
  platform: 'cli',
  roleName: 'owner_console',
  role: {
    model: 'gpt-5.6-sol',
    allowedTools: ['task_update', 'telegram_send', 'contract_no_update'],
    blockedTools: [],
    allowedPaths: [],
    systemControl: false,
    sensitiveAccess: false,
  },
  session: { sessionId: 'owner-event', channelId: 'owner-event', startedAt: new Date(0) },
  capabilities: ['task_update', 'telegram_send', 'contract_no_update'],
  limitations: [],
  tier: 1,
  backend: 'codex',
};

const batch = () => ({
  channelKey: 'chatwork:C1',
  eventIds: ['evt-1'],
  lines: ['- client: feedback arrived'],
  activations: [],
});

const result = (history: Array<{ role: string; content: unknown }>) => ({
  response: 'done',
  history,
});

// One MAMA: completion is a ledger change; the notification rides beside it.
const deliveredHistory = [
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'task-1', name: 'task_update', input: {} },
      { type: 'tool_use', id: 'send-1', name: 'telegram_send', input: {} },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'task-1', content: JSON.stringify({ success: true }) },
      { type: 'tool_result', tool_use_id: 'send-1', content: JSON.stringify({ success: true }) },
    ],
  },
];

// A turn that only notified: the notification alone is not a ledger change.
const notifiedHistory = notificationHistory('FYI: feedback arrived.');
// The marker lives in the SENT text; a "[decision]" response over a plain send does not count.
const decisionHistory = notificationHistory('[decision] Approve the revised quote?');

function notificationHistory(message: string) {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'send-1',
          name: 'telegram_send',
          input: { chat_id: 'owner', message },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'send-1', content: JSON.stringify({ success: true }) },
      ],
    },
  ];
}

describe('TG-03/TG-05/TG-06 OwnerEventLoop', () => {
  let db: SQLiteDatabase;
  let inbox: OwnerEventInbox;
  let now: number;

  beforeEach(() => {
    db = new Database(':memory:');
    now = 1_000;
    inbox = new OwnerEventInbox(db, () => now);
  });

  it('TG-04/TG-05 pins admission revision and retains queued reference', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 't1',
          kind: 'feedback',
          memoryQuery: 'old',
          procedure: [{ action: 'read', description: 'old' }],
          requiredEvidence: [],
          procedureRef: { id: 'p1', revision: 1 },
        },
      ],
    });
    let calls = 0;
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      resolveActivation: (activation) => ({
        ...activation,
        procedureRef: { id: 'p1', revision: 2 },
        procedure: [{ action: 'read', description: 'new' }],
      }),
      buildPrompt: (current) => {
        expect(current.activations[0].procedureRef?.revision).toBe(2);
        expect(current.activations[0].queuedProcedureRef?.revision).toBe(1);
        calls++;
        return 'prompt';
      },
      runner: {
        run: async (_prompt, options) => {
          expect(options.procedureRefs).toEqual([{ id: 'p1', revision: 2 }]);
          return result(deliveredHistory);
        },
      },
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: () => {},
    });
    expect(await loop.tick()).toBe('processed');
    expect(calls).toBe(1);
    const stored = db.prepare('SELECT activations_json FROM owner_event_inbox').get() as {
      activations_json: string;
    };
    expect(JSON.parse(stored.activations_json)[0].queuedProcedureRef.revision).toBe(1);
  });

  it('TG-05 reinterprets pending activation after lane wait immediately before model input', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 't1',
          kind: 'report',
          memoryQuery: 'report',
          procedure: [],
          requiredEvidence: [],
          procedureRef: { id: 'p1', revision: 1 },
        },
      ],
    });
    let revision = 1;
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      resolveActivation: (a) => ({
        ...a,
        procedureRef: { id: 'p1', revision },
        procedure: [{ action: 'apply', description: `body-${revision}` }],
      }),
      buildPrompt: (b) => b.activations[0].procedure[0].description,
      runner: {
        run: async (_prompt, options) => {
          revision = 2;
          const prepared = await options.prepareContent!();
          expect(prepared.content).toEqual([{ type: 'text', text: 'body-2' }]);
          expect(prepared.procedureRefs).toEqual([{ id: 'p1', revision: 2 }]);
          expect(options.sourceMessageRef).toBe('owner-event:1');
          return result(deliveredHistory);
        },
      },
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: () => {},
    });
    expect(await loop.tick()).toBe('processed');
  });

  it('TG-04 isolates a resolver failure before prompt exposure while other work continues', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 'private',
          kind: 'private-name',
          memoryQuery: 'private-query',
          procedure: [{ action: 'read', description: 'private-body' }],
          requiredEvidence: ['private-evidence'],
          procedureRef: { id: 'p1', revision: 1 },
        },
      ],
    });
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      resolveActivation: () => {
        throw new Error('private failure detail');
      },
      buildPrompt: (current) => {
        expect(current.activations[0].availability).toBe('unavailable');
        expect(current.activations[0].kind).toBe('');
        expect(current.activations[0].procedure).toEqual([]);
        return 'independent work';
      },
      runner: {
        run: async (_prompt, options) => {
          expect(options.procedureRefs).toEqual([]);
          return result(deliveredHistory);
        },
      },
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: () => {},
    });
    expect(await loop.tick()).toBe('processed');
  });

  it('drains the owner event turn before allowing the operator database to close', async () => {
    const order: string[] = [];
    let release!: () => void;
    const closing = closeOwnerEventBeforeDatabase(
      () =>
        new Promise<void>((resolve) => {
          order.push('owner-event:stopping');
          release = () => {
            order.push('owner-event:stopped');
            resolve();
          };
        }),
      async () => {
        order.push('database:closed');
      }
    );

    await Promise.resolve();
    expect(order).toEqual(['owner-event:stopping']);
    release();
    await closing;
    expect(order).toEqual(['owner-event:stopping', 'owner-event:stopped', 'database:closed']);
  });

  it('TG-05 uses one durable owner runtime session across different channel batches', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 'feedback-trigger',
          kind: 'feedback relay',
          memoryQuery: 'feedback',
          procedure: [],
          requiredEvidence: [],
        },
      ],
    });
    inbox.enqueue({
      channelKey: 'slack:C2',
      eventIds: ['evt-2'],
      lines: ['- client: second feedback arrived'],
      activations: [],
    });
    const seenOptions: Array<Record<string, unknown>> = [];
    const outcomes: Array<[string, 'succeeded' | 'failed']> = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        run: async (_prompt, options) => {
          seenOptions.push(options);
          return result(deliveredHistory);
        },
      },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      recordTriggerOutcome: (triggerId, outcome) => outcomes.push([triggerId, outcome]),
      log: () => {},
    });

    expect(await loop.tick()).toBe('processed');
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    expect(seenOptions).toHaveLength(2);
    expect(seenOptions.map((options) => options.sessionKey)).toEqual([
      'owner:runtime',
      'owner:runtime',
    ]);
    expect(seenOptions).toEqual([
      expect.objectContaining({
        source: 'owner-event',
        actorId: 'mama-owner',
        channelId: 'chatwork:C1',
        agentContext: ownerContext,
        causeEventIds: ['evt-1'],
        sourceMessageRef: 'owner-event:1',
      }),
      expect.objectContaining({
        source: 'owner-event',
        actorId: 'mama-owner',
        channelId: 'slack:C2',
        agentContext: ownerContext,
        causeEventIds: ['evt-2'],
        sourceMessageRef: 'owner-event:2',
      }),
    ]);
    expect(seenOptions.every((options) => !('freshSession' in options))).toBe(true);
    expect(outcomes).toEqual([['feedback-trigger', 'succeeded']]);
    expect(inbox.unresolvedAcks()).toEqual([]);
  });

  it('ACKs a durable terminal receipt before waking the model after a crash', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 'retired',
          kind: 'old',
          memoryQuery: 'old',
          procedure: [],
          requiredEvidence: [],
          procedureRef: { id: 'retired-procedure', revision: 1 },
        },
      ],
    });
    let resolutions = 0;
    let runs = 0;
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      resolveActivation: () => {
        resolutions++;
        throw new Error('retired');
      },
      runner: {
        run: async () => {
          runs += 1;
          return result([]);
        },
      },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      getTerminalReceipt: () => ({
        status: 'acted',
        tools: ['drive_upload'],
        ownerDecisionRequested: false,
      }),
      log: () => {},
    });

    expect(await loop.tick()).toBe('processed');
    expect(runs).toBe(0);
    expect(resolutions).toBe(0);
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
  });

  it('rechecks durable receipts after a prose-only run before scheduling retry', async () => {
    inbox.enqueue(batch());
    let receiptReads = 0;
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => result([{ role: 'assistant', content: 'already handled' }]) },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      getTerminalReceipt: () => {
        receiptReads += 1;
        return receiptReads === 1 ? null : { status: 'delegated', tools: ['workorder_request'] };
      },
      log: () => {},
    });

    expect(await loop.tick()).toBe('processed');
    expect(receiptReads).toBe(2);
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
  });

  it('rechecks durable receipts after a runner error before scheduling retry', async () => {
    inbox.enqueue(batch());
    let receiptReads = 0;
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        run: async () => {
          throw new Error('process died after external delivery');
        },
      },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      getTerminalReceipt: () => {
        receiptReads += 1;
        return receiptReads === 1
          ? null
          : { status: 'acted', tools: ['drive_upload'], ownerDecisionRequested: false };
      },
      log: () => {},
    });

    expect(await loop.tick()).toBe('processed');
    expect(receiptReads).toBe(2);
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
  });

  it('retries instead of ACKing a prose-only response', async () => {
    inbox.enqueue(batch());
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => result([{ role: 'assistant', content: 'Delivered.' }]) },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: () => {},
    });

    expect(await loop.tick()).toBe('failed');
    expect(inbox.depth()).toEqual({ pending: 1, claimed: 0, dead: 0 });
  });

  it('ACKs an exact no-update receipt even when no mutation tool ran', async () => {
    inbox.enqueue(batch());
    let reads = 0;
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => result([]) },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: (scope) => {
        expect(scope).toBe('owner-event:1');
        reads += 1;
        return reads === 1 ? 0 : 1;
      },
      log: () => {},
    });

    expect(await loop.tick()).toBe('processed');
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
  });

  it('records trigger failure only when an unreceipted event exhausts retries', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 'poison-trigger',
          kind: 'poison',
          memoryQuery: 'poison',
          procedure: [],
          requiredEvidence: [],
        },
      ],
    });
    const outcomes: Array<[string, 'succeeded' | 'failed']> = [];
    const dead: string[] = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => result([{ role: 'assistant', content: 'done' }]) },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      recordTriggerOutcome: (triggerId, outcome) => outcomes.push([triggerId, outcome]),
      onDead: (message) => dead.push(message),
      log: () => {},
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await loop.tick()).toBe('failed');
      if (attempt < 4) expect(outcomes).toEqual([]);
      now += 43_200_000;
    }

    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 1 });
    expect(outcomes).toEqual([['poison-trigger', 'failed']]);
    expect(dead).toEqual([expect.stringContaining('batch 1')]);
  });

  it('does not replay a completed effect when trigger statistics recording fails', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 'retired-trigger',
          kind: 'retired',
          memoryQuery: 'retired',
          procedure: [],
          requiredEvidence: [],
        },
      ],
    });
    const logs: string[] = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => result(deliveredHistory) },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      recordTriggerOutcome: () => {
        throw new Error('trigger retired concurrently');
      },
      log: (line) => logs.push(line),
    });

    expect(await loop.tick()).toBe('processed');
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    expect(logs).toEqual(
      expect.arrayContaining([expect.stringContaining('trigger outcome skipped')])
    );
  });

  it('pages and records failure when thrown runner errors exhaust the batch', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 'throwing-trigger',
          kind: 'throwing',
          memoryQuery: 'throwing',
          procedure: [],
          requiredEvidence: [],
        },
      ],
    });
    const outcomes: Array<[string, 'succeeded' | 'failed']> = [];
    const dead: string[] = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        run: async () => {
          throw new Error('provider failed');
        },
      },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      recordTriggerOutcome: (triggerId, outcome) => outcomes.push([triggerId, outcome]),
      onDead: (message) => dead.push(message),
      log: () => {},
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await loop.tick()).toBe('failed');
      now += 43_200_000;
    }

    expect(outcomes).toEqual([['throwing-trigger', 'failed']]);
    expect(dead).toEqual([expect.stringContaining('provider failed')]);
  });

  it('pages and records failure when repeated lease replay parks a claim dead', async () => {
    inbox.enqueue({
      ...batch(),
      activations: [
        {
          triggerId: 'lease-trigger',
          kind: 'lease',
          memoryQuery: 'lease',
          procedure: [],
          requiredEvidence: [],
        },
      ],
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      inbox.claimNext();
      inbox.replayStale(0);
      now += 43_200_000;
    }
    expect(inbox.claimNext()).not.toBeNull();

    const outcomes: Array<[string, 'succeeded' | 'failed']> = [];
    const dead: string[] = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => result([]) },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      recordTriggerOutcome: (triggerId, outcome) => outcomes.push([triggerId, outcome]),
      onDead: (message) => dead.push(message),
      log: () => {},
      leaseMs: 0,
    });

    expect(await loop.tick()).toBe('idle');
    expect(outcomes).toEqual([['lease-trigger', 'failed']]);
    expect(dead).toEqual([expect.stringContaining('lease expired repeatedly')]);
  });
  it('ONE-MAMA-P1 Task 2 AC #1 (TG-06): acks a [decision] notification and retries a plain notification', async () => {
    inbox.enqueue(batch());
    const decisionLoop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        // Response says [decision] too, but the ACK must come from the SENT message.
        run: async () => ({
          response: '[decision] Approve the revised quote?',
          history: decisionHistory,
        }),
      },
      buildPrompt: async () => 'prompt',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: () => {},
    });
    expect(await decisionLoop.tick()).toBe('processed');
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    expect(inbox.unresolvedAcks()).toEqual([
      expect.objectContaining({ id: 1, reason: 'owner_decision_requested' }),
    ]);

    inbox.enqueue({ ...batch(), eventIds: ['evt-2'] });
    const logs: string[] = [];
    const plainLoop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      // A "[decision]" response over a plain notification is NOT a decision.
      runner: {
        run: async () => ({ response: '[decision] pretend', history: notifiedHistory }),
      },
      buildPrompt: async () => 'prompt',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: (line) => logs.push(line),
    });
    expect(await plainLoop.tick()).toBe('failed');
    expect(logs.at(-1)).toContain('notification without a ledger change');
  });
  it('TG-05 submits the bounded delta without a host-compiled bulk packet', async () => {
    inbox.enqueue(batch());
    const seen: number[] = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => result(deliveredHistory) },
      buildPrompt: async (claimed) => {
        seen.push(claimed.id);
        return 'prompt';
      },
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: () => {},
    });
    expect(await loop.tick()).toBe('processed');
    expect(seen).toEqual([1]);
  });
  it('ONE-MAMA-P3 Task 2 AC #12: a dead batch records one inbox issue with the reason and the channel', async () => {
    inbox.enqueue(batch());
    const issues: Array<{ channelKey: string; reason: string }> = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: { run: async () => ({ response: 'prose only', history: [] }) },
      buildPrompt: async () => 'prompt',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      recordIssue: (input) => issues.push(input),
      log: () => {},
    });
    // exhaust retries until dead
    for (let i = 0; i < 12 && inbox.depth().dead === 0; i += 1) {
      await loop.tick();
      now += 24 * 60 * 60 * 1000;
    }
    expect(inbox.depth().dead).toBe(1);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ channelKey: 'chatwork:C1' });
    expect(issues[0].reason).toContain('no durable action');
  });
  it('ONE-MAMA-P3 Task 4 AC #2: a budget-stopped run stays retryable with a named reason and is not dead', async () => {
    inbox.enqueue(batch());
    const logs: string[] = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        run: async () => ({ response: 'partial', history: [], stoppedBy: 'budget' as const }),
      },
      buildPrompt: async () => 'prompt',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: (line) => logs.push(line),
    });
    expect(await loop.tick()).toBe('failed');
    expect(inbox.depth()).toEqual({ pending: 1, claimed: 0, dead: 0 });
    expect(logs.at(-1)).toContain('run stopped on its token budget');
    // a budget stop AFTER a ledger change still completes
    inbox.enqueue({ ...batch(), eventIds: ['evt-2'] });
    const acted = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        run: async () => ({
          response: 'partial',
          history: deliveredHistory,
          stoppedBy: 'budget' as const,
        }),
      },
      buildPrompt: async () => 'prompt',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      log: () => {},
    });
    expect(await acted.tick()).toBe('processed');
  });
});

describe('TG-05/TG-06 owner-event native replay quarantine', () => {
  it.each(['before-admission', 'after-native-effect', 'acted-budget'] as const)(
    'parks an unsettled occurrence %s',
    async (phase) => {
      const db = new Database(':memory:');
      try {
        const inbox = new OwnerEventInbox(db);
        const effects = new OwnerActionEffectLedger(db);
        const id = inbox.enqueue(batch())!;
        const key = `owner-event:${id}`;
        const reserve = () =>
          effects.begin(
            {
              ownerScope: 'owner:runtime',
              occurrenceKey: key,
              modelRunId: 'mr-native',
              envelopeHash: 'hash',
            },
            'native-admission',
            // A real external effect: the `native_run` admission marker alone is
            // deliberately NOT a quarantine reason (see hasUnsafeReplayEffects).
            'telegram_send',
            {}
          );
        if (phase === 'before-admission') {
          reserve();
        }
        let calls = 0;
        const loop = new OwnerEventLoop({
          inbox,
          agentContext: ownerContext,
          issueEnvelope: issueTestEnvelope,
          buildPrompt: async () => 'test',
          getNoUpdateMaxId: () => 0,
          log: () => {},
          hasUnsafeReplayEffects: () => effects.hasUnsafeReplayEffects(key),
          hasUnsettledEffects: () => effects.hasUnsettledEffects(key),
          runner: {
            run: async () => {
              calls++;
              reserve();
              if (phase === 'acted-budget') {
                return { ...result(deliveredHistory), stoppedBy: 'budget' as const };
              }
              throw new Error('native transport disconnected');
            },
          },
        });
        expect(await loop.tick()).toBe('failed');
        expect(calls).toBe(phase === 'before-admission' ? 0 : 1);
        expect(inbox.depth()).toMatchObject({ dead: 1, pending: 0 });
        await loop.tick();
        expect(calls).toBe(phase === 'before-admission' ? 0 : 1);
      } finally {
        db.close();
      }
    }
  );

  it('replays an occurrence whose interrupted run left only a native_run marker', async () => {
    const db = new Database(':memory:');
    try {
      const inbox = new OwnerEventInbox(db);
      const effects = new OwnerActionEffectLedger(db);
      const id = inbox.enqueue(batch())!;
      const key = `owner-event:${id}`;
      const context = {
        ownerScope: 'owner:runtime',
        occurrenceKey: key,
        modelRunId: 'mr-interrupted',
        envelopeHash: 'hash',
      };
      effects.begin(context, 'native-admission', 'native_run', {});
      effects.markUnknown(context, 'native-admission', 'native_run', 'did not finish cleanly');
      let calls = 0;
      const loop = new OwnerEventLoop({
        inbox,
        agentContext: ownerContext,
        issueEnvelope: issueTestEnvelope,
        buildPrompt: async () => 'test',
        getNoUpdateMaxId: () => 0,
        log: () => {},
        hasUnsafeReplayEffects: () => effects.hasUnsafeReplayEffects(key),
        hasUnsettledEffects: () => effects.hasUnsettledEffects(key),
        runner: {
          run: async () => {
            calls++;
            return result(deliveredHistory);
          },
        },
      });
      expect(await loop.tick()).toBe('processed');
      expect(calls).toBe(1);
      expect(inbox.depth()).toMatchObject({ dead: 0, pending: 0 });
    } finally {
      db.close();
    }
  });
});
