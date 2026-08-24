import { beforeEach, describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
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
    allowedTools: ['telegram_send', 'contract_no_update'],
    blockedTools: [],
    allowedPaths: [],
    systemControl: false,
    sensitiveAccess: false,
  },
  session: { sessionId: 'owner-event', channelId: 'owner-event', startedAt: new Date(0) },
  capabilities: ['telegram_send', 'contract_no_update'],
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

const deliveredHistory = [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'send-1', name: 'telegram_send', input: {} }],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'send-1',
        content: JSON.stringify({ success: true }),
      },
    ],
  },
];

describe('TG-03/TG-05/TG-06 OwnerEventLoop', () => {
  let db: SQLiteDatabase;
  let inbox: OwnerEventInbox;
  let now: number;

  beforeEach(() => {
    db = new Database(':memory:');
    now = 1_000;
    inbox = new OwnerEventInbox(db, () => now);
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

  it('runs the event as the MAMA owner agent on a durable per-channel session', async () => {
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
    let seenOptions: Record<string, unknown> | undefined;
    const outcomes: Array<[string, 'succeeded' | 'failed']> = [];
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        run: async (_prompt, options) => {
          seenOptions = options;
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
    expect(seenOptions).toMatchObject({
      sessionKey: 'owner-event:chatwork:C1',
      source: 'owner-event',
      actorId: 'mama-owner',
      channelId: 'chatwork:C1',
      freshSession: true,
      agentContext: ownerContext,
      causeEventIds: ['evt-1'],
      sourceMessageRef: 'owner-event:1',
    });
    // Stateless lane: resuming the per-channel thread replayed the whole growing
    // history on every batch (45.9M tokens on 2026-08-20 alone, weekly quota blowout).
    expect(seenOptions?.resumeSession).toBeUndefined();
    expect(outcomes).toEqual([['feedback-trigger', 'succeeded']]);
  });

  it('ACKs a durable terminal receipt before waking the model after a crash', async () => {
    inbox.enqueue(batch());
    let runs = 0;
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: ownerContext,
      runner: {
        run: async () => {
          runs += 1;
          return result([]);
        },
      },
      buildPrompt: async () => '[MAMA OWNER EVENT TURN]',
      issueEnvelope: issueTestEnvelope,
      getNoUpdateMaxId: () => 0,
      getTerminalReceipt: () => ({ status: 'acted', tools: ['telegram_send'] }),
      log: () => {},
    });

    expect(await loop.tick()).toBe('processed');
    expect(runs).toBe(0);
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
        return receiptReads === 1 ? null : { status: 'acted', tools: ['telegram_send'] };
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
});
