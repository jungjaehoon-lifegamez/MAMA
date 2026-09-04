import { describe, expect, it, vi } from 'vitest';
import Database from '../../src/sqlite.js';
import { OperatorTriggerLoop } from '../../src/operator/operator-trigger-loop.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { OwnerEventBoardRefreshLedger } from '../../src/operator/owner-event-board-refresh.js';
import { OwnerEventEffectLedger } from '../../src/operator/owner-event-effects.js';
import { OwnerEventLoop } from '../../src/operator/owner-event-loop.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { resolveOwnerEventTerminalReceipt } from '../../src/cli/commands/start.js';
import { buildOwnerEventAgentContext } from '../../src/operator/owner-event-policy.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import type { Envelope } from '../../src/envelope/types.js';

describe('TG-03/TG-04/TG-05/TG-06 production owner-event seam', () => {
  function ownerContext() {
    return buildOwnerEventAgentContext({
      backend: 'codex',
      model: 'gpt-5.6-sol',
      ownerRole: DEFAULT_ROLES.definitions.owner_console,
      privateConnectorPolicy: resolvePrivateConnectorPolicy({
        ok: true,
        config: { kagemusha: { enabled: true } },
        enabledNames: ['kagemusha'],
      }),
    });
  }

  function envelope(): Envelope {
    return {
      scope: { allowed_destinations: [{ kind: 'telegram', id: 'owner-chat' }] },
    } as Envelope;
  }

  it('moves one connector event from durable intake to a receipted MAMA owner turn', async () => {
    const db = new Database(':memory:');
    const registry = new TriggerRegistry(db);
    const inbox = new OwnerEventInbox(db);
    registry.create({
      id: 'feedback-trigger',
      kind: 'feedback relay',
      memoryQuery: 'feedback policy',
      match: { keywords: ['feedback'], keywordMode: 'any', minConfidence: 0.9 },
      procedure: [{ action: 'deliver', description: 'Deliver translated feedback.' }],
      requiredEvidence: ['current_message'],
      authoredBy: 'agent',
      provenance: { createdFrom: 'owner instruction', note: 'standing responsibility' },
    });
    let drained = false;
    const triggerLoop = new OperatorTriggerLoop({
      delta: {
        drainNew: () => {
          if (drained) return [];
          drained = true;
          return [
            {
              id: 1,
              eventIndexId: 'evt-feedback',
              channel: 'chatwork',
              channelId: 'C1',
              userId: 'client',
              role: 'user' as const,
              content: 'feedback arrived',
              createdAt: 1,
            },
          ];
        },
        commit: () => {},
      },
      memory: { save: async () => {}, recall: async () => [] },
      registry,
      ownerEventInbox: inbox,
      askAgent: async () => '[]',
      review: async () => ({ action: 'kept' as const }),
      config: {
        tickMs: 60_000,
        drainLimit: 50,
        authorEveryNTicks: 99,
        reviewEveryNTicks: 99,
        authorWindowSize: 10,
      },
      log: () => {},
    });
    await triggerLoop.tick();
    expect(inbox.depth().pending).toBe(1);

    const privatePolicy = resolvePrivateConnectorPolicy({
      ok: true,
      config: { kagemusha: { enabled: true } },
      enabledNames: ['kagemusha'],
    });
    const context = buildOwnerEventAgentContext({
      backend: 'codex',
      model: 'gpt-5.6-sol',
      ownerRole: DEFAULT_ROLES.definitions.owner_console,
      privateConnectorPolicy: privatePolicy,
    });
    const envelope = {
      scope: { allowed_destinations: [{ kind: 'telegram', id: 'owner-chat' }] },
    } as Envelope;
    let runOptions: Record<string, unknown> | undefined;
    const ownerLoop = new OwnerEventLoop({
      inbox,
      agentContext: context,
      runner: {
        run: async (_prompt, options) => {
          runOptions = options;
          return {
            response: 'recorded and delivered',
            history: [
              {
                role: 'assistant',
                content: [
                  { type: 'tool_use', id: 'task-1', name: 'task_create', input: {} },
                  { type: 'tool_use', id: 'send-1', name: 'telegram_send', input: {} },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'task-1',
                    content: JSON.stringify({ success: true }),
                  },
                  {
                    type: 'tool_result',
                    tool_use_id: 'send-1',
                    content: JSON.stringify({ success: true }),
                  },
                ],
              },
            ],
          };
        },
      },
      buildPrompt: async (batch) =>
        `MAMA owns ${batch.activations[0]?.procedure[0]?.description ?? 'the event'}`,
      issueEnvelope: async () => envelope,
      getNoUpdateMaxId: () => 0,
      recordTriggerOutcome: (id, outcome) => registry.recordOutcome(id, outcome),
      log: () => {},
    });

    expect(await ownerLoop.tick()).toBe('processed');
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    expect(runOptions).toMatchObject({
      actorId: 'mama-owner',
      sessionKey: 'owner-event:chatwork:C1',
      sourceMessageRef: 'owner-event:1',
      causeEventIds: ['evt-feedback'],
      ownerEventEffects: {
        batchId: 1,
        effectKeys: {
          telegram_send: 'telegram-delivery',
          drive_upload: 'drive-upload',
        },
      },
      envelope,
    });
    expect(registry.getById('feedback-trigger')?.stats).toEqual({
      fired: 1,
      succeeded: 1,
      failed: 0,
    });
    registry.close();
  });

  it('a persisted Board acceptance is not a terminal receipt: the model is woken', async () => {
    const db = new Database(':memory:');
    const taskLedger = new TaskLedger(db);
    const inbox = new OwnerEventInbox(db);
    const effects = new OwnerEventEffectLedger(db);
    const boardIntents = new OwnerEventBoardRefreshLedger(db, taskLedger);
    const batchId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['evt-restart'],
      lines: ['feedback arrived'],
      activations: [],
    });
    if (batchId === null) throw new Error('test batch unexpectedly deduplicated');
    boardIntents.accept({
      batchId,
      eventIds: ['evt-restart'],
      repair: { repairGeneration: 20, noUpdateScope: 'full:20' },
    });
    const runner = {
      run: vi.fn(async () => ({
        response: 'updated',
        history: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'task_update', input: {} }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: JSON.stringify({ success: true }),
              },
            ],
          },
        ],
      })),
    };
    const loop = new OwnerEventLoop({
      inbox,
      runner,
      agentContext: ownerContext(),
      buildPrompt: () => 'handle feedback',
      issueEnvelope: async () => envelope(),
      getNoUpdateMaxId: (scope) => taskLedger.maxNoUpdateId(scope),
      getTerminalReceipt: (batch) =>
        resolveOwnerEventTerminalReceipt(batch, {
          ownerEventEffectLedger: effects,
          taskLedger,
        }),
      log: () => undefined,
    });

    expect(await loop.tick()).toBe('processed');
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    db.close();
  });

  it('terminal receipt: a confirmed deliverable counts, a confirmed notification alone does not', () => {
    const db = new Database(':memory:');
    const taskLedger = new TaskLedger(db);
    const inbox = new OwnerEventInbox(db);
    const effects = new OwnerEventEffectLedger(db);
    const batchId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['evt-receipt'],
      lines: ['feedback arrived'],
      activations: [],
    });
    if (batchId === null) throw new Error('test batch unexpectedly deduplicated');
    const batch = inbox.claimNext();
    if (!batch) throw new Error('batch not claimable');
    const deps = { ownerEventEffectLedger: effects, taskLedger };

    expect(resolveOwnerEventTerminalReceipt(batch, deps)).toBeNull();

    effects.begin(batchId, 'telegram-delivery', 'telegram_send', {});
    effects.confirm(batchId, 'telegram-delivery', 'telegram_send', { messageId: 1 });
    expect(resolveOwnerEventTerminalReceipt(batch, deps)).toBeNull();

    effects.begin(batchId, 'drive-upload', 'drive_upload', {});
    effects.confirm(batchId, 'drive-upload', 'drive_upload', { fileId: 'f1' });
    expect(resolveOwnerEventTerminalReceipt(batch, deps)).toEqual({
      status: 'acted',
      tools: ['drive_upload'],
    });
    db.close();
  });

  it('terminal receipt: a ledger write caused by the batch survives a runner crash', () => {
    const db = new Database(':memory:');
    const taskLedger = new TaskLedger(db);
    const inbox = new OwnerEventInbox(db);
    const effects = new OwnerEventEffectLedger(db);
    const batchId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['evt-crash-1', 'evt-crash-2'],
      lines: ['feedback arrived'],
      activations: [],
    });
    if (batchId === null) throw new Error('test batch unexpectedly deduplicated');
    const batch = inbox.claimNext();
    if (!batch) throw new Error('batch not claimable');
    const deps = { ownerEventEffectLedger: effects, taskLedger };
    expect(resolveOwnerEventTerminalReceipt(batch, deps)).toBeNull();

    // Another batch's task must not count for this one.
    taskLedger.create(
      { title: 'someone else' },
      { runId: 'mr_other', causeEventIds: ['evt-other'] }
    );
    expect(resolveOwnerEventTerminalReceipt(batch, deps)).toBeNull();

    taskLedger.create(
      { title: 'created then crashed' },
      { runId: 'mr_1', causeEventIds: ['evt-crash-2'] }
    );
    expect(resolveOwnerEventTerminalReceipt(batch, deps)).toEqual({
      status: 'acted',
      tools: ['task_create'],
    });
    db.close();
  });
});
