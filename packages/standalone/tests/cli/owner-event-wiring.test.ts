import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { OperatorTriggerLoop } from '../../src/operator/operator-trigger-loop.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { OwnerEventLoop } from '../../src/operator/owner-event-loop.js';
import { buildOwnerEventAgentContext } from '../../src/operator/owner-event-policy.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import type { Envelope } from '../../src/envelope/types.js';

describe('TG-03/TG-04/TG-05/TG-06 production owner-event seam', () => {
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
            response: 'delivered',
            history: [
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
});
