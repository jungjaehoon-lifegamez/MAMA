import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Database from '../../src/sqlite.js';
import { OperatorTriggerLoop } from '../../src/operator/operator-trigger-loop.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { OwnerEventEffectLedger } from '../../src/operator/owner-event-effects.js';
import { OwnerEventLoop } from '../../src/operator/owner-event-loop.js';
import { buildOwnerEventPrompt } from '../../src/operator/owner-event-prompt.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { resolveOwnerEventTerminalReceipt } from '../../src/cli/commands/start.js';
import { buildOwnerEventAgentContext } from '../../src/operator/owner-event-policy.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import type { Envelope } from '../../src/envelope/types.js';
import { deriveMemoryScopes } from '../../src/memory/scope-context.js';

describe('TG-03/TG-04/TG-05/TG-06 production owner-event seam', () => {
  const ownerPrincipalId = 'principal-owner-event-wiring';

  function ownerContext() {
    return buildOwnerEventAgentContext({
      backend: 'codex',
      model: 'gpt-5.6-sol',
      principalId: ownerPrincipalId,
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
      scope: {
        principal_id: ownerPrincipalId,
        allowed_destinations: [{ kind: 'telegram', id: 'owner-chat' }],
      },
    } as Envelope;
  }

  it('TG-05 production prompt assembly never reads same-channel prior context', () => {
    const source = readFileSync(
      new URL('../../src/cli/commands/start.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/ownerEventInbox\.readPriorContext\s*\(/);
  });

  it('never runs the subagent wake turn without envelope authority', () => {
    const source = readFileSync(
      new URL('../../src/cli/commands/start.ts', import.meta.url),
      'utf8'
    );
    const start = source.indexOf('attachSubagentWake(agentLoop.getModelRunner()');
    expect(start).toBeGreaterThan(-1);
    const wakeBlock = source.slice(start, source.indexOf('});', start));
    // A nested '});' would truncate the slice and make the negative assertion vacuous:
    // pin a token from the END of the registration call so truncation fails loudly.
    expect(wakeBlock).toContain('prepareSubagentEnvelope');
    // Issuance off must throw like every sibling owner path, not run unauthorised.
    expect(wakeBlock).toContain('requireOwnerRuntimeEnvelope(');
    expect(wakeBlock).not.toContain('prepareEnvelope: () => issueOwnerRuntimeEnvelope(');
  });

  /**
   * Review P2-5: the child's grant derives its memory scopes from its channel, so a
   * hardcoded 'subagent' gave every owner child a channel scope nobody reads and dropped
   * the parent run's channel binding.
   */
  it('P2-5 derives a child grant from the PARENT channel, not a literal subagent channel', () => {
    const projectId = '/tmp/project';
    const parent = deriveMemoryScopes({ source: 'operator', channelId: 'report', projectId });
    const hardcoded = deriveMemoryScopes({ source: 'operator', channelId: 'subagent', projectId });
    expect(parent).toContainEqual({ kind: 'channel', id: 'operator:report' });
    expect(hardcoded).not.toContainEqual({ kind: 'channel', id: 'operator:report' });

    const source = readFileSync(
      new URL('../../src/cli/commands/start.ts', import.meta.url),
      'utf8'
    );
    // The issuer takes the caller's channel; no owner site re-binds the child to a literal.
    expect(source).toContain(
      'const issueOwnerSubagentEnvelope = (channelId: string) =>\n    issueOwnerRuntimeEnvelope(channelId, 1800)'
    );
    expect(source).not.toContain('prepareSubagentEnvelope: issueOwnerSubagentEnvelope,');
    expect(source).toContain(
      'prepareSubagentEnvelope: () => issueOwnerSubagentEnvelope(channelId)'
    );
    expect(source).toContain("prepareSubagentEnvelope: () => issueOwnerSubagentEnvelope('report')");
    expect(source).toContain(
      "prepareSubagentEnvelope: () => issueOwnerSubagentEnvelope('heartbeat')"
    );
    expect(source).toContain(
      "prepareSubagentEnvelope: () => issueOwnerSubagentEnvelope('trigger-maintenance')"
    );
  });

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
      principalId: ownerPrincipalId,
      ownerRole: DEFAULT_ROLES.definitions.owner_console,
      privateConnectorPolicy: privatePolicy,
    });
    const envelope = {
      scope: {
        principal_id: ownerPrincipalId,
        allowed_destinations: [{ kind: 'telegram', id: 'owner-chat' }],
      },
    } as Envelope;
    let runOptions: Record<string, unknown> | undefined;
    const ownerLoop = new OwnerEventLoop({
      inbox,
      agentContext: context,
      runner: {
        run: async (_prompt, options) => {
          runOptions = options;
          expect(options).not.toHaveProperty('envelope');
          expect(await options.prepareEnvelope()).toBe(envelope);
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
      sessionKey: 'owner:runtime',
      sourceMessageRef: 'owner-event:1',
      causeEventIds: ['evt-feedback'],
      ownerEventEffects: {
        batchId: 1,
        effectKeys: {
          telegram_send: 'telegram-delivery',
          drive_upload: 'drive-upload',
        },
      },
      prepareEnvelope: expect.any(Function),
    });
    expect(runOptions).not.toHaveProperty('freshSession');
    expect(registry.getById('feedback-trigger')?.stats).toEqual({
      fired: 1,
      succeeded: 1,
      failed: 0,
    });
    registry.close();
  });

  it('a batch with no durable receipt wakes the model', async () => {
    const db = new Database(':memory:');
    const taskLedger = new TaskLedger(db);
    const inbox = new OwnerEventInbox(db);
    const effects = new OwnerEventEffectLedger(db);
    const batchId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['evt-restart'],
      lines: ['feedback arrived'],
      activations: [],
    });
    if (batchId === null) {
      throw new Error('test batch unexpectedly deduplicated');
    }
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

  it('TG-05 chunks 200 channel events without losing refs across ACK and replay', async () => {
    const db = new Database(':memory:');
    const inbox = new OwnerEventInbox(db);
    const registry = new TriggerRegistry(db);
    const events = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      eventIndexId: `evt-chunk-${index + 1}`,
      observationRef: index % 5 === 0 ? null : `obs-chunk-${index + 1}`,
      channel: 'slack',
      channelId: 'C-chunk',
      userId: 'synthetic-member',
      role: 'user' as const,
      content: `chunk content ${index + 1}`,
      createdAt: index + 1,
    }));
    let drains = 0;
    const commit = vi.fn();
    const loop = new OperatorTriggerLoop({
      delta: {
        drainNew: () => (drains++ < 2 ? events : []),
        commit,
      },
      memory: { save: async () => {}, recall: async () => [] },
      registry,
      ownerEventInbox: inbox,
      askAgent: async () => '[]',
      review: async () => ({ action: 'kept' as const }),
      config: {
        tickMs: 60_000,
        drainLimit: 250,
        authorEveryNTicks: 999,
        reviewEveryNTicks: 999,
        authorWindowSize: 10,
      },
      log: () => {},
    });

    await loop.tick();
    expect(commit).toHaveBeenCalledWith(events);
    expect(inbox.depth().pending).toBe(4);
    const seenIds: string[] = [];
    for (let chunk = 0; chunk < 4; chunk += 1) {
      const batch = inbox.claimNext();
      expect(batch).not.toBeNull();
      expect(batch!.eventIds).toHaveLength(50);
      expect(batch!.eventRefs).toHaveLength(50);
      expect(batch!.lines).toHaveLength(10);
      seenIds.push(...batch!.eventIds);
      const displayedIds = batch!.lines.map((line) => /\[id:([^\]]+)\]/.exec(line)?.[1]);
      expect(displayedIds).toEqual(batch!.eventIds.slice(-10));
      const prompt = buildOwnerEventPrompt({
        batch: batch!,
        ownerBrief: 'brief',
        ownerTelegramChatId: 'owner-chat',
      });
      const available = batch!.eventRefs.filter((ref) => ref.observationRef !== null);
      expect(prompt).toContain(
        `Observation refs: total=50 available=${available.length} legacy_null=${50 - available.length}`
      );
      for (const ref of available) {
        expect(prompt).toContain(ref.observationRef!);
      }
      inbox.ack(batch!.id, 'no_update');
    }
    expect(new Set(seenIds).size).toBe(200);
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });

    await loop.tick();
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    expect(commit).toHaveBeenCalledTimes(2);
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
    if (batchId === null) {
      throw new Error('test batch unexpectedly deduplicated');
    }
    const batch = inbox.claimNext();
    if (!batch) {
      throw new Error('batch not claimable');
    }
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
      ownerDecisionRequested: false,
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
    if (batchId === null) {
      throw new Error('test batch unexpectedly deduplicated');
    }
    const batch = inbox.claimNext();
    if (!batch) {
      throw new Error('batch not claimable');
    }
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
      ownerDecisionRequested: false,
    });
    db.close();
  });

  it('TG-01/TG-05/TG-06 keeps stored audit history out of a continued turn after DB reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mama-owner-event-context-'));
    const dbPath = join(directory, 'operator.db');
    try {
      let now = Date.parse('2026-09-04T01:00:00.000Z');
      const firstDb = new Database(dbPath);
      const firstInbox = new OwnerEventInbox(firstDb, () => now);
      const firstEffects = new OwnerEventEffectLedger(firstDb, () => now);
      new TaskLedger(firstDb, { now: () => now });
      const oldId = firstInbox.enqueue({
        channelKey: 'chatwork:feedback',
        eventIds: Array.from({ length: 50 }, (_, i) => `old-event-${i + 1}`),
        lines: Array.from({ length: 10 }, (_, i) => `old visible line ${i + 1}`),
        activations: [],
      })!;
      firstInbox.claimNext();
      const intent = {
        version: 1,
        chatId: 'owner-chat',
        variant: 'text',
        deliveryId: `owner-event:${oldId}:telegram:telegram-delivery`,
        message: '[decision] prior owner question',
        filePath: null,
        stickerEmotion: null,
      };
      firstEffects.begin(oldId, 'telegram-delivery', 'telegram_send', intent);
      firstEffects.confirm(oldId, 'telegram-delivery', 'telegram_send', {
        version: 1,
        deliveryId: intent.deliveryId,
        variant: 'text',
        state: 'delivered',
        payloadIdentity: 'sha256:prior-redacted-fixture',
        confirmedAt: now,
      });
      firstInbox.ack(oldId, 'owner_decision_requested');
      firstDb.close();

      now = Date.parse('2026-09-05T01:00:00.000Z');
      const reopenedDb = new Database(dbPath);
      const inbox = new OwnerEventInbox(reopenedDb, () => now);
      const taskLedger = new TaskLedger(reopenedDb, { now: () => now });
      const currentId = inbox.enqueue({
        channelKey: 'chatwork:feedback',
        eventIds: Array.from({ length: 50 }, (_, i) => `current-event-${i + 1}`),
        lines: Array.from({ length: 10 }, (_, i) => `current visible line ${i + 1}`),
        activations: [],
      })!;
      let seenPrompt = '';
      const runner = {
        run: vi.fn(async (prompt: string) => {
          seenPrompt = prompt;
          taskLedger.recordNoUpdate(`owner-event:${currentId}`, 'same state, no new action');
          return {
            response: 'quiet',
            history: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'no-update-1',
                    name: 'contract_no_update',
                    input: { scope: `owner-event:${currentId}`, reason: 'same state' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'no-update-1',
                    content: JSON.stringify({ success: true }),
                  },
                ],
              },
            ],
          };
        }),
      };
      const loop = new OwnerEventLoop({
        inbox,
        runner,
        agentContext: ownerContext(),
        buildPrompt: (batch) =>
          buildOwnerEventPrompt({
            batch,
            ownerBrief: 'brief',
            ownerTelegramChatId: 'owner-chat',
          }),
        issueEnvelope: async () => envelope(),
        getNoUpdateMaxId: (scope) => taskLedger.maxNoUpdateId(scope),
        log: () => undefined,
      });

      expect(await loop.tick()).toBe('processed');
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(seenPrompt).not.toContain('[decision] prior owner question');
      expect(seenPrompt).not.toContain('historical data only');
      expect(seenPrompt).not.toContain('current-event-1');
      expect(
        reopenedDb
          .prepare(`SELECT COUNT(*) AS n FROM owner_event_effects WHERE batch_id = ?`)
          .get(currentId)
      ).toEqual({ n: 0 });
      expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
      reopenedDb.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('TG-05 does not replay a newer ACKed batch when an older backed-off batch retries', async () => {
    let now = 1_000;
    const db = new Database(':memory:');
    const inbox = new OwnerEventInbox(db, () => now);
    const taskLedger = new TaskLedger(db, { now: () => now });
    const olderId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['older-event'],
      lines: ['older observation'],
      activations: [],
    })!;
    const older = inbox.claimNext();
    if (!older) throw new Error('older batch was not claimable');
    expect(inbox.retry(older.id, 'temporary provider failure')).toBe('pending');

    now += 1_000;
    const newerId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['newer-event'],
      lines: ['newer handling completed while older batch waited'],
      activations: [],
    })!;
    const newer = inbox.claimNext();
    if (!newer) throw new Error('newer batch was not claimable');
    taskLedger.recordNoUpdate(`owner-event:${newerId}`, 'newer batch already checked');
    inbox.ack(newerId);

    now += 59_000;
    let seenPrompt = '';
    const loop = new OwnerEventLoop({
      inbox,
      runner: {
        run: async (prompt) => {
          seenPrompt = prompt;
          taskLedger.recordNoUpdate(`owner-event:${olderId}`, 'retry saw newer handling');
          return {
            response: 'quiet',
            history: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'no-update-old',
                    name: 'contract_no_update',
                    input: { scope: `owner-event:${olderId}`, reason: 'already handled' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'no-update-old',
                    content: JSON.stringify({ success: true }),
                  },
                ],
              },
            ],
          };
        },
      },
      agentContext: ownerContext(),
      buildPrompt: (batch) =>
        buildOwnerEventPrompt({
          batch,
          ownerBrief: 'brief',
        }),
      issueEnvelope: async () => envelope(),
      getNoUpdateMaxId: (scope) => taskLedger.maxNoUpdateId(scope),
      log: () => undefined,
    });

    expect(await loop.tick()).toBe('processed');
    expect(seenPrompt).not.toContain('newer handling completed while older batch waited');
    expect(seenPrompt).toContain('older observation');
    expect(seenPrompt).not.toContain('## Prior same-channel handling');
    db.close();
  });

  it('TG-06 projects plain Telegram plus exact no-update as no_update and excludes Telegram-only ACKs', async () => {
    let now = 1_000;
    const db = new Database(':memory:');
    const inbox = new OwnerEventInbox(db, () => now);
    const taskLedger = new TaskLedger(db, { now: () => now });
    const effects = new OwnerEventEffectLedger(db, () => now);
    const addConfirmedNotification = (batchId: number, message: string) => {
      const intent = {
        version: 1,
        chatId: 'owner-chat',
        variant: 'text',
        deliveryId: `owner-event:${batchId}:telegram:telegram-delivery`,
        message,
        filePath: null,
        stickerEmotion: null,
      };
      effects.begin(batchId, 'telegram-delivery', 'telegram_send', intent);
      effects.confirm(batchId, 'telegram-delivery', 'telegram_send', {
        version: 1,
        deliveryId: intent.deliveryId,
        variant: intent.variant,
        state: 'delivered',
        payloadIdentity: `sha256:batch-${batchId}`,
        confirmedAt: now,
      });
    };

    const noUpdateId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['no-update-event'],
      lines: ['administrative confirmation'],
      activations: [],
    })!;
    inbox.claimNext();
    addConfirmedNotification(noUpdateId, 'Informational confirmation');
    taskLedger.recordNoUpdate(`owner-event:${noUpdateId}`, 'no new action');
    inbox.ack(noUpdateId);

    now += 1_000;
    const driveId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['drive-event'],
      lines: ['real Drive artifact completed'],
      activations: [],
    })!;
    inbox.claimNext();
    effects.begin(driveId, 'drive-upload', 'drive_upload', { occurrence: 'redacted-fixture' });
    effects.confirm(driveId, 'drive-upload', 'drive_upload', { fileId: 'redacted-file' });
    inbox.ack(driveId);

    now += 1_000;
    const telegramOnlyId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['telegram-only-event'],
      lines: ['legacy Telegram-only ACK'],
      activations: [],
    })!;
    inbox.claimNext();
    addConfirmedNotification(telegramOnlyId, 'Plain notification without terminal proof');
    inbox.ack(telegramOnlyId);

    now += 1_000;
    const currentId = inbox.enqueue({
      channelKey: 'chatwork:feedback',
      eventIds: ['current-event'],
      lines: ['current observation'],
      activations: [],
    })!;
    let seenPrompt = '';
    const loop = new OwnerEventLoop({
      inbox,
      runner: {
        run: async (prompt) => {
          seenPrompt = prompt;
          taskLedger.recordNoUpdate(`owner-event:${currentId}`, 'no current action');
          return {
            response: 'quiet',
            history: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'no-update-current',
                    name: 'contract_no_update',
                    input: { scope: `owner-event:${currentId}`, reason: 'no current action' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'no-update-current',
                    content: JSON.stringify({ success: true }),
                  },
                ],
              },
            ],
          };
        },
      },
      agentContext: ownerContext(),
      buildPrompt: (batch) =>
        buildOwnerEventPrompt({
          batch,
          ownerBrief: 'brief',
          ownerTelegramChatId: 'owner-chat',
        }),
      issueEnvelope: async () => envelope(),
      getNoUpdateMaxId: (scope) => taskLedger.maxNoUpdateId(scope),
      log: () => undefined,
    });

    expect(await loop.tick()).toBe('processed');
    expect(seenPrompt).not.toContain('real Drive artifact completed');
    expect(seenPrompt).not.toContain('administrative confirmation');
    expect(seenPrompt).not.toContain('Informational confirmation');
    expect(seenPrompt).not.toContain('Plain notification without terminal proof');
    expect(seenPrompt).not.toContain('legacy Telegram-only ACK');
    expect(seenPrompt).toContain('current observation');
    db.close();
  });
});
